import logging
import re
from typing import List, Dict, Optional

try:
    import fitz        # PyMuPDF
    import numpy as np
    FITZ_OK = True
except ImportError:
    FITZ_OK = False

logger = logging.getLogger("ledgerai.rubber_binding")


# ─── Step 1: Auto-detect row-grouping tolerance ───────────────────────────────

def _detect_row_tolerance(doc) -> float:
    """
    Derive the y-proximity tolerance for grouping words into rows directly
    from the PDF's own gap distribution — no bank-specific hardcoding needed.

    The distribution of consecutive-word y0 gaps is bimodal:
      • Cluster A  (0–Xpx)   — intra-row jitter AND wrapped overflow lines
                                (both belong to the same visual table row)
      • Cluster C  (Ypx–…)   — true inter-row spacing

    We locate the valley between A and C and place the tolerance at its
    midpoint, safely above every same-row gap and safely below every
    new-row gap.

    Why the valley, not just "half the line-height"?
    Federal Bank (and some other banks) wrap long Particulars strings onto a
    second PDF line.  The wrapped fragment sits ~8–20 px below its parent
    line — well above the intra-row jitter but well below the true inter-row
    spacing (~27.5 px).  A fixed tolerance of 5 px (the original default)
    cuts through this overflow zone and splits the row; the auto-detected
    value (~23.5 px for Federal Bank) spans the whole overflow zone.
    """
    gaps = []
    for page in doc:
        ys = sorted(w[1] for w in page.get_text("words") if w[4].strip())
        for i in range(1, len(ys)):
            g = ys[i] - ys[i - 1]
            if 0.05 < g < 100:          # exclude same-pixel and page-jump gaps
                gaps.append(g)

    if len(gaps) < 20:
        return 5.0                      # not enough data — original default

    gaps_arr = np.array(gaps)
    hist, edges = np.histogram(gaps_arr, bins=np.arange(0, gaps_arr.max() + 2, 1))
    centres = (edges[:-1] + edges[1:]) / 2

    # ── Step 1: find the dominant inter-row cluster (C) ──────────────────────
    # Use the median of gaps > 3 px as a rough midpoint; C's peak will be
    # the tallest bin above 80 % of that midpoint.
    upper_mask = centres > np.median(gaps_arr[gaps_arr > 3]) * 0.8
    if not upper_mask.any():
        return 5.0
    c_peak_idx     = int(upper_mask.nonzero()[0][np.argmax(hist[upper_mask])])
    c_peak_height  = hist[c_peak_idx]

    # ── Step 2: locate the valley immediately to the left of C ───────────────
    # Right edge of valley: scan left from C's peak until density < 15 % of peak.
    valley_right_idx = c_peak_idx
    for idx in range(c_peak_idx - 1, 0, -1):
        if hist[idx] < c_peak_height * 0.15:
            valley_right_idx = idx
            break

    # Left edge of valley: continue scanning left until density rises again
    # (= upper boundary of the overflow / B cluster).
    valley_left_idx = valley_right_idx
    for idx in range(valley_right_idx - 1, 0, -1):
        if hist[idx] >= max(c_peak_height * 0.15, 2):
            valley_left_idx = idx + 1   # first empty bin after B
            break

    valley_lo = centres[valley_left_idx]
    valley_hi = centres[valley_right_idx]

    # ── Step 3: tolerance = midpoint of valley, clamped to a safe range ──────
    raw = (valley_lo + valley_hi) / 2
    tolerance = float(np.clip(round(raw, 1), 4.0, 40.0))

    logger.debug(
        "Auto-detected row tolerance: %.1f px  "
        "(valley %.1f–%.1f px, inter-row peak %.1f px)",
        tolerance, valley_lo, valley_hi, centres[c_peak_idx],
    )
    return tolerance


# ─── Step 2: Extract PDF words with coordinates ──────────────────────────────

def _get_pdf_words(page_fitz) -> List[dict]:
    """Return all non-empty words on a page with their bounding coordinates."""
    raw = page_fitz.get_text("words")
    # w[0]=x0  w[1]=y0  w[2]=x1  w[3]=y1  w[4]=text
    return [
        {"text": w[4], "x0": w[0], "y0": w[1], "x1": w[2], "y1": w[3]}
        for w in raw if w[4].strip()
    ]


# ─── Step 3: Group nearby words into rows ────────────────────────────────────

def _group_words_into_rows(
    words: List[dict],
    tolerance: float,
) -> List[List[dict]]:
    """
    Cluster words into rows based on y0 proximity.

    Two words are on the same visual row when their y0 values differ by less
    than *tolerance*.  The tolerance is intentionally wider than simple
    intra-row jitter so that overflow/wrapped lines (which land a few px below
    their parent line) are folded into the same row rather than becoming
    orphan rows.
    """
    if not words:
        return []

    words = sorted(words, key=lambda w: w["y0"])
    rows: List[List[dict]] = []
    current_row = [words[0]]

    for word in words[1:]:
        if word["y0"] - current_row[0]["y0"] < tolerance:
            current_row.append(word)
        else:
            rows.append(sorted(current_row, key=lambda w: w["x0"]))
            current_row = [word]

    rows.append(sorted(current_row, key=lambda w: w["x0"]))
    return rows


# ─── Step 4: Match an extracted transaction to a PDF row ─────────────────────

def _is_match(extracted_txn: dict, pdf_row_text: str) -> bool:
    """
    Return True when the PDF row text is consistent with the extracted
    transaction.
    """
    row_clean = pdf_row_text.lower()

    # ── Description matching ─────────────────────────────────────────────────
    desc = (
        extracted_txn.get("details", "")
        or extracted_txn.get("description", "")
        or extracted_txn.get("particulars", "")
        or extracted_txn.get("narration", "")
    ).lower()

    if desc:
        # Split on any non-alphanumeric character to cleanly isolate words/numbers
        sub_tokens = [t for t in re.split(r"[^a-z0-9]+", desc) if t]
        significant_tokens = [t for t in sub_tokens if len(t) >= 4]
        if not significant_tokens:
            significant_tokens = [t for t in sub_tokens if len(t) >= 3]
        if not significant_tokens:
            significant_tokens = sub_tokens

        desc_clean = "".join(sub_tokens)
        row_clean_alnum = re.sub(r"[^a-z0-9]+", "", row_clean)
        row_tokens = set(t for t in re.split(r"[^a-z0-9]+", row_clean) if t)

        # Match if the full contiguous text is present OR any significant token is in the row
        desc_match = (desc_clean and desc_clean in row_clean_alnum) or any(
            tok in row_tokens for tok in significant_tokens
        )
    else:
        desc_match = False

    # ── Amount matching (word-boundary anchored) ─────────────────────────────
    row_clean_amt = row_clean.replace(",", "")
    
    # Robust extraction of amount, preferring amount, then debit, then credit
    amt_val = extracted_txn.get("amount")
    if amt_val in (None, ""):
        amt_val = extracted_txn.get("debit")
        if amt_val in (None, "", 0, 0.0):
            amt_val = extracted_txn.get("credit")
            
    raw_amt_str = str(amt_val).replace(",", "").strip() if amt_val not in (None, "") else ""

    amt_match = False
    if raw_amt_str:
        try:
            f_amt = float(raw_amt_str)
            if f_amt.is_integer():
                base_amt = str(int(f_amt))
                # Must be bounded by start/end/space/letters/dot/symbols
                pattern = r"(?:^|\s)" + re.escape(base_amt) + r"(?:\.0*)?(?:$|\s|[a-z]+|[\.\-\+\*])"
            else:
                base_amt = str(f_amt)
                pattern = r"(?:^|\s)" + re.escape(base_amt) + r"0*(?:$|\s|[a-z]+|[\.\-\+\*])"
            
            amt_match = bool(re.search(pattern, row_clean_amt))
        except ValueError:
            amt_clean = re.sub(r"\.0+$", "", raw_amt_str)
            pattern = r"(?:^|\s)" + re.escape(amt_clean) + r"(?:$|\s|[a-z]+|[\.\-\+\*])"
            amt_match = bool(re.search(pattern, row_clean_amt))
    else:
        amt_match = False

    return desc_match and amt_match


# ─── Step 5: Attach bounding boxes to transactions ───────────────────────────

def attach_bboxes(
    transactions: List[Dict],
    pdf_path: str,
    password: Optional[str] = None,
) -> List[Dict]:
    """
    Main entry point.

    For each transaction in *transactions*, find the corresponding row in
    *pdf_path* and attach ``bbox`` (4-element list [x0, y0, x1, y1]) and
    ``page`` (1-based page number) fields.  Unmatched transactions get
    ``bbox=None, page=None``.
    """
    if not FITZ_OK:
        return [dict(t, bbox=None, page=None) for t in transactions]

    doc = None
    try:
        doc = fitz.open(pdf_path)
        if doc.is_encrypted:
            doc.authenticate(password or "")

        # Auto-detect the tolerance for this specific PDF.
        tolerance = _detect_row_tolerance(doc)
        logger.debug("Using row tolerance: %.1f px for %s", tolerance, pdf_path)

        # Build per-page row cache.
        all_pages_rows: Dict[int, List[List[dict]]] = {}
        for p_idx in range(len(doc)):
            words = _get_pdf_words(doc[p_idx])
            all_pages_rows[p_idx + 1] = _group_words_into_rows(words, tolerance)

        # ── Step 5.1: Pass 1 - Find the starting row for each transaction ──
        used_rows: set = set()   # (page, row_index)
        matched_txns = []        # list of dicts with match details

        for i, txn in enumerate(transactions):
            match_found = False

            for p_num, rows in all_pages_rows.items():
                for r_idx, row in enumerate(rows):
                    if (p_num, r_idx) in used_rows:
                        continue

                    row_text = " ".join(w["text"] for w in row)

                    if _is_match(txn, row_text):
                        matched_txns.append({
                            "txn_idx": i,
                            "txn": txn,
                            "p_num": p_num,
                            "r_idx": r_idx,
                            "row": row
                        })
                        used_rows.add((p_num, r_idx))
                        match_found = True
                        break

                if match_found:
                    break

            if not match_found:
                matched_txns.append({
                    "txn_idx": i,
                    "txn": txn,
                    "p_num": None,
                    "r_idx": None,
                    "row": None
                })

        # ── Step 5.2: Pass 2 - Data-Driven Lane Locking & Vertical Expansion ──
        augmented: List[Dict] = [None] * len(transactions)
        
        # Group matches by page
        page_to_matches = {}
        for m in matched_txns:
            if m["p_num"] is not None:
                page_to_matches.setdefault(m["p_num"], []).append(m)
            else:
                augmented[m["txn_idx"]] = dict(m["txn"], bbox=None, page=None)

        for p_num, matches in page_to_matches.items():
            # Sort matches chronologically / vertically
            matches.sort(key=lambda x: x["r_idx"])
            
            rows = all_pages_rows[p_num]
            
            # Calculate global table width (Lane Locking) for this page
            all_x0 = [min(w["x0"] for w in m["row"]) for m in matches]
            all_x1 = [max(w["x1"] for w in m["row"]) for m in matches]
            table_x0 = min(all_x0) if all_x0 else 0
            table_x1 = max(all_x1) if all_x1 else 0
            
            # Calculate typical row spacing in the table to detect breaks
            y_diffs = []
            for j in range(len(matches) - 1):
                r1 = matches[j]["r_idx"]
                r2 = matches[j+1]["r_idx"]
                if r2 > r1:
                    y1_0 = min(w["y0"] for w in rows[r1])
                    y2_0 = min(w["y0"] for w in rows[r2])
                    y_diffs.append((y2_0 - y1_0) / (r2 - r1))
            
            typical_spacing = float(np.median(y_diffs)) if y_diffs else tolerance * 1.5
            max_spacing = max(typical_spacing * 1.8, tolerance * 2.0, 25.0)
            
            for i, m in enumerate(matches):
                start_r_idx = m["r_idx"]
                limit_r_idx = matches[i+1]["r_idx"] if i + 1 < len(matches) else len(rows)
                
                y0 = min(w["y0"] for w in rows[start_r_idx])
                y1 = max(w["y1"] for w in rows[start_r_idx])
                
                txn_desc = (
                    m["txn"].get("details", "")
                    or m["txn"].get("description", "")
                    or m["txn"].get("particulars", "")
                    or m["txn"].get("narration", "")
                ).lower()
                txn_desc_alnum = re.sub(r"[^a-z0-9]+", "", txn_desc)
                txn_desc_tokens = set(t for t in re.split(r"[^a-z0-9]+", txn_desc) if len(t) >= 3)
                
                # Expand downwards to capture multiline descriptions
                for curr_r_idx in range(start_r_idx + 1, limit_r_idx):
                    curr_row = rows[curr_r_idx]
                    
                    prev_row = rows[curr_r_idx - 1]
                    prev_y1 = max(w["y1"] for w in prev_row)
                    
                    curr_y0 = min(w["y0"] for w in curr_row)
                    prev_y0 = min(w["y0"] for w in prev_row)
                    
                    # 1. Stop if vertical gap is too large (likely a footer or new paragraph)
                    whitespace_gap = curr_y0 - prev_y1
                    if (curr_y0 - prev_y0 > max_spacing) or (whitespace_gap > max(tolerance * 1.5, 25.0)):
                        break
                        
                    # Stop on explicit footer text
                    curr_row_text = " ".join(w["text"] for w in curr_row).lower().strip()
                    if (curr_row_text.startswith("page ") or 
                        "end of statement" in curr_row_text or 
                        "closing balance" in curr_row_text or
                        "opening balance" in curr_row_text or
                        "total" == curr_row_text):
                        break
                        
                    # 2. Stop if row is completely outside the table lanes
                    curr_x0 = min(w["x0"] for w in curr_row)
                    curr_x1 = max(w["x1"] for w in curr_row)
                    if curr_x0 > table_x1 or curr_x1 < table_x0:
                        break
                        
                    # 3. Data-driven multiline continuation check
                    curr_row_alnum = re.sub(r"[^a-z0-9]+", "", curr_row_text)
                    curr_row_tokens = [t for t in re.split(r"[^a-z0-9]+", curr_row_text) if len(t) >= 3]
                    
                    is_in_desc = False
                    if curr_row_alnum and curr_row_alnum in txn_desc_alnum:
                        is_in_desc = True
                    elif curr_row_tokens and any(tok in txn_desc_tokens for tok in curr_row_tokens):
                        is_in_desc = True
                        
                    # If this row shares NO text with the extracted description, it is likely a footer.
                    if txn_desc and not is_in_desc:
                        break
                        
                    # Include this row in the bounding box
                    y1 = max(y1, max(w["y1"] for w in curr_row))
                
                # Assign the Lane-Locked bounding box
                augmented[m["txn_idx"]] = dict(
                    m["txn"], 
                    bbox=[table_x0 - 2, y0 - 2, table_x1 + 2, y1 + 2], 
                    page=p_num
                )

        return augmented

    except Exception as exc:
        logger.error("Rubber Binding Error: %s", exc)
        return [dict(t, bbox=None, page=None) for t in transactions]
    finally:
        if doc:
            doc.close()