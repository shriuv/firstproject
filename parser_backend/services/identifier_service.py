import re
import json
import logging
from typing import Dict, List, Optional

from config import CLASSIFIER_MODEL
from services.llm_provider import call_llm
from repository.statement_category_repo import (
    get_all_matchable_formats,
    insert_statement_category,
)

logger = logging.getLogger("ledgerai.identifier_service")


# ════════════════════════════════════════════════════════════
# INSTITUTION NAME NORMALISATION  [UNTOUCHED]
# ════════════════════════════════════════════════════════════
_LEGAL_SUFFIX_RE = re.compile(
    r"\s*,?\s*\b(limited|ltd\.?|pvt\.?|private)\s*$",
    re.IGNORECASE,
)


_COMMON_ABBREVIATIONS = {
    "BOI": "BANK OF INDIA",
    "SBI": "STATE BANK OF INDIA",
    "HDFC": "HDFC BANK",
    "ICICI": "ICICI BANK",
    "AXIS": "AXIS BANK",
    "TJSB": "TJSB SAHAKARI BANK",
}


def normalise_institution_name(raw: str) -> str:
    """
    Strip trailing legal registration suffixes, bracketed text, and punctuation.
    Returns UPPERCASE.
    Example: "TJSB (Thane Janata Sahakari Bank)" -> "TJSB SAHAKARI BANK"
    """
    if not raw or not raw.strip():
        return "UNKNOWN"
    
    # 1. Basic cleaning: uppercase and strip
    name = raw.strip().upper()
    
    # 2. Remove bracketed content (often contains abbreviations or full names)
    # e.g., "BANK OF BARODA (BOB)" -> "BANK OF BARODA"
    # e.g., "TJSB (THANE JANATA SAHAKARI BANK)" -> "TJSB"
    # We try to keep the part OUTSIDE the brackets if possible.
    if "(" in name and ")" in name:
        parts = re.split(r"[\(\)]", name)
        # Find the most "meaningful" part (longest or specifically TJSB)
        meaningful_parts = [p.strip() for p in parts if p.strip()]
        if meaningful_parts:
            # If any part is "TJSB", prefer that
            if any("TJSB" in p for p in meaningful_parts):
                name = "TJSB"
            else:
                name = meaningful_parts[0]

    # 3. Handle common abbreviations / synonyms
    # We do this BEFORE stripping legal suffixes to catch "SBI LTD"
    if name in _COMMON_ABBREVIATIONS:
        return _COMMON_ABBREVIATIONS[name]
    
    # Also check if any abbreviation is PART of the name
    for abbr, full in _COMMON_ABBREVIATIONS.items():
        if name == abbr or name == full:
            return full

    # 4. Strip common leading articles like "THE "
    if name.startswith("THE "):
        name = name[4:].strip()
        
    # 5. Strip trailing legal registration suffixes (Limited, Ltd, etc.)
    prev = None
    while prev != name:
        prev = name
        name = _LEGAL_SUFFIX_RE.sub("", name).strip().rstrip(",").strip()
        
    # 6. Final check against abbreviations after stripping
    if name in _COMMON_ABBREVIATIONS:
        return _COMMON_ABBREVIATIONS[name]
        
    return name


# ════════════════════════════════════════════════════════════
# FIRST N PAGES EXTRACTION
# Own function — does not reuse any existing service function
# ════════════════════════════════════════════════════════════

def _get_first_pages_text(pages: List[str], max_pages: int = 3) -> str:
    """
    Concatenate text from the first `max_pages` pages only.
    Adds a lightweight page marker so the LLM can orient itself.

    Sending only the first 2-3 pages to the LLM keeps token usage low
    while still capturing all structural signals (title, column headers,
    account markers, regulatory IDs) that appear at the top of a statement.
    """
    chunks = []
    for i, page_text in enumerate(pages[:max_pages], start=1):
        text = page_text.strip()
        if text:
            chunks.append(f"--- PAGE {i} ---\n{text}")
    return "\n\n".join(chunks)


# ════════════════════════════════════════════════════════════
# FORMAT EXISTENCE CHECK
# Own function — does not reuse any existing service function
# ════════════════════════════════════════════════════════════

def _get_column_set(identifier_json: dict) -> set:
    """
    Extract a set of normalised column names.
    Strips whitespace, units in brackets (INR), and non-alphanumeric noise.
    """
    headers = (
        identifier_json
        .get("identity_markers", {})
        .get("transaction_table_identity", {})
        .get("table_header_markers", [])
    )
    cols = set()
    for h in headers:
        if not h or not str(h).strip():
            continue
        
        # 1. Lowercase and remove whitespace
        s = str(h).lower().strip()
        s = re.sub(r"\s+", "", s)
        
        # 2. Strip bracketed noise (INR), (Cr/Dr), (Rs.)
        s = re.sub(r"\(.*?\)", "", s)
        
        # 3. Remove non-alphanumeric (No. -> No, Cr/Dr -> CrDr)
        s = re.sub(r"[^a-z0-9]", "", s)
        
        # 4. Remove common currency/unit suffix noise if attached
        if s.endswith("inr"): s = s[:-3]
        if s.endswith("rs"):  s = s[:-2]

        if s:
            cols.add(s)
            
    return cols


def check_format_exists(
    new_id_json: dict,
    col_similarity_threshold: float = 0.65,
) -> Optional[Dict]:
    """
    Check if an equivalent format exists in the database.

    Match criteria: Same Institution Name + Column Overlap >= threshold (Jaccard).
    """
    raw_inst      = new_id_json.get("institution_name") or ""
    new_norm_inst = normalise_institution_name(raw_inst)

    if not new_norm_inst or new_norm_inst == "UNKNOWN":
        return None

    new_cols = _get_column_set(new_id_json)

    try:
        all_rows: List[Dict] = get_all_matchable_formats()
    except Exception as exc:
        logger.warning("check_format_exists: DB fetch failed — %s", exc)
        return None

    best_match = None
    best_overlap = 0.0

    for row in all_rows:
        # ── 1. Institution must match first (hard gate) ───────────────────────
        stored_norm_inst = normalise_institution_name(row.get("institution_name") or "")
        if stored_norm_inst != new_norm_inst:
            continue

        # Parse stored JSON
        stored_json = row.get("statement_identifier", {})
        if isinstance(stored_json, str):
            try: stored_json = json.loads(stored_json)
            except: continue

        # ── 2. Column Overlap (Jaccard) ───────────────────────────────────────
        stored_cols = _get_column_set(stored_json)
        if not new_cols or not stored_cols:
            col_overlap = 0.0
        else:
            intersection = new_cols.intersection(stored_cols)
            union        = new_cols.union(stored_cols)
            col_overlap  = len(intersection) / len(union) if union else 0.0

        # ── 3. Decision ───────────────────────────────────────────────────────
        if col_overlap >= col_similarity_threshold and col_overlap > best_overlap:
            best_overlap = col_overlap
            best_match   = row
        elif col_overlap > 0:
            logger.debug(
                "check_format_exists: partial match for %s (overlap=%.2f < %.2f)",
                new_norm_inst, col_overlap, col_similarity_threshold
            )

    if best_match:
        logger.info(
            "check_format_exists: HIT — statement_id=%s (column_overlap=%.2f)",
            best_match.get("statement_id"), best_overlap,
        )
        return best_match

    logger.info(
        "check_format_exists: NO match for institution='%s' (cols=%s) with threshold %.2f",
        new_norm_inst, list(new_cols), col_similarity_threshold,
    )
    return None



# ════════════════════════════════════════════════════════════
# CLASSIFY DOCUMENT — GENERATE IDENTIFICATION JSON  (LLM)
# ════════════════════════════════════════════════════════════

def classify_document_llm(pages: List[str]) -> Dict:
    """
    Generate the identification marker JSON for a new document.

    The identification prompt is defined inline as a local variable.
    Sends only the first 2-3 pages to the LLM to conserve tokens —
    structural signals (title, column headers, account/entity patterns)
    are always present within the first pages of a financial statement.

    Args:
        pages: Per-page text list produced by the page-split logic in
               processing_engine.py.

    Returns:
        Parsed identification JSON dict with institution_name normalised.
    """
    # ── Build page text (first 2-3 pages only) ───────────────────────────────
    first_pages_text = _get_first_pages_text(pages, max_pages=3)

    prompt = f"""
You are a financial document structure analyst. Your task is to analyze a financial statement PDF and generate a comprehensive identification marker JSON that captures all unique structural, textual, and formatting patterns that distinguish this specific statement type.

══════════════════════════════════════════════════════════════════════════════
ANALYSIS WORKFLOW
══════════════════════════════════════════════════════════════════════════════

STEP 1: DOCUMENT CLASSIFICATION
- Identify the issuing institution name. 
  CRITICAL: Prioritize the document header, footer, logo area, and official contact sections. 
  CAUTION: Many Indian bank statements (like TJSB, Federal, etc.) have minimal headers. Look for bank names in branch addresses or copyright notes. 
  HINT: The concatenated string "SavingAccountStatement" (no spaces) is a strong marker for TJSB (Thane Janata Sahakari Bank).
  WARNING: DO NOT assume a bank mentioned in a single transaction (e.g., "BOI EMI", "BKID", "HDFC UPI") is the issuer if it appears in the description/narration column. These are almost always counterparties.
- Identify the document family: BANK_STATEMENT | CREDIT_CARD | WALLET | LOAN | INVESTMENT | INSURANCE | TAX | OTHER
- Identify the document subtype: Savings, Current, Platinum Card, Gold Card, Mutual Fund, Demat, etc.
- Assign confidence score (0.0-1.0) based on clarity of identification

STEP 2: EXTRACT ISSUER IDENTITY MARKERS
- Bank/Institution name patterns (exact strings that appear)
- Regulatory identifiers:
  * IFSC code pattern (if bank statement)
  * SWIFT code pattern (if applicable)
  * IBAN pattern (if applicable)
  * GSTIN (if applicable)
  * Any other regulatory IDs visible

STEP 3: EXTRACT DOCUMENT STRUCTURE IDENTITY
- Document title phrase (exact text, e.g., "ACCOUNT STATEMENT", "CREDIT CARD STATEMENT")
- Document reference number pattern (statement number, reference ID format)
- Generation phrase patterns (e.g., "Generated on", "Statement Date")

STEP 4: EXTRACT PERIOD IDENTITY MARKERS
- Statement period format (e.g., "01-Jan-2024 to 31-Jan-2024")
- Statement date format
- Billing cycle patterns (for credit cards)
- Tax period patterns (for investment/tax statements)

STEP 5: EXTRACT ENTITY IDENTITY MARKERS
Capture regex patterns for:
- Account number (full or masked format)
- Card number (masked, e.g., XXXX XXXX XXXX 1234)
- Loan account number
- Customer ID / CIF number
- Wallet ID (for payment wallets)
- Merchant ID (if applicable)
- PAN number
- BO ID / DP ID (for demat/investment accounts)

STEP 6: EXTRACT TRANSACTION TABLE IDENTITY
- List ALL column headers exactly as they appear (e.g., ["Date", "Description", "Debit", "Credit", "Balance"])
- Count minimum columns in transaction table
- Note if running balance column exists (true/false)
- Note if debit/credit style is used vs. single amount column (true/false)

STEP 7: EXTRACT FINANCIAL SUMMARY IDENTITY
Capture regex patterns that extract:
- Total outstanding amount (credit cards)
- Minimum amount due
- EMI amount (for loans)
- Credit limit (for credit cards/overdraft)
- Drawing power (for overdraft accounts)
- Portfolio value (for investment accounts)
- Total tax (for tax statements)

STEP 8: EXTRACT FOOTER IDENTITY
- List footer text patterns that consistently appear (disclaimers, contact info, etc.)

STEP 9: DEFINE EXCLUSION MARKERS
List patterns that should EXCLUDE lines from being treated as transactions:
- Page headers/footers (e.g., "Page 1 of 5")
- Section headers (e.g., "Transaction Details", "Summary")
- Disclaimer text
- Total/subtotal lines (e.g., "Total Debits", "Closing Balance")
- Empty or separator lines

STEP 10: DEFINE PARSING HINTS
- layout_type: SINGLE_COLUMN | TWO_COLUMN_PDF | MULTI_SECTION
- summary_section_labels: Labels that mark summary lines, not transactions (e.g., ["Opening Balance", "Closing Balance", "Total Credits"])
- transaction_boundary_signals: Signals that mark start of transaction (typically ["DATE"])
- ref_no_pattern: Regex to match and strip ONLY the raw reference code/number from descriptions. CRITICAL: Do NOT include words like "Ref No" or "ID" in the pattern unless they are truly noise—prefer keeping descriptive labels.
- page_break_pattern: Pattern for page numbering (e.g., "Page \\\\d+ of \\\\d+")
- details_strip_patterns: Regex patterns to remove raw alphanumeric ID hashes or long reference numbers (e.g., 12-digit UPI refs) from narrations. CRITICAL: NEVER include words like "UPI", "Ref No", "NEFT", "RTGS", "IMPS", or "ID" in these patterns. ONLY target the variable numbers/codes, preserving the descriptive labels.
- known_summary_amounts: Exact amount strings that are summary values, never transactions

══════════════════════════════════════════════════════════════════════════════
STATEMENT ID VERSIONING RULE
══════════════════════════════════════════════════════════════════════════════
ID format: [document_family]_[institution_abbreviation]_[document_subtype]_V[version_number]

Examples:
- BANK_STATEMENT_HDFC_SAVINGS_V1
- CREDIT_CARD_ICICI_PLATINUM_V1
- WALLET_PAYTM_MAIN_V1
- LOAN_SBI_HOME_V1
- INVESTMENT_ZERODHA_DEMAT_V1

══════════════════════════════════════════════════════════════════════════════
REGEX PATTERN RULES
══════════════════════════════════════════════════════════════════════════════
- Use Python regex syntax
- Escape special characters properly (\\\\d, \\\\s, \\\\., etc.)
- Make patterns specific but flexible enough to handle minor variations
- Use named groups where helpful: (?P<account>\\\\d{{10,16}})
- For dates, match actual format seen (e.g., "\\\\d{{2}}-[A-Z][a-z]{{2}}-\\\\d{{4}}" for "01-Jan-2024")
- For amounts, match format with commas/decimals: "[\\\\d,]+\\\\.\\\\d{{2}}"
- Return null if a field is not applicable to this statement type

══════════════════════════════════════════════════════════════════════════════
OUTPUT FORMAT
══════════════════════════════════════════════════════════════════════════════
Return ONLY valid JSON matching this exact structure:

{{
  "id": "[document_family]_[institution]_[subtype]_V1",
  "document_family": "BANK_STATEMENT|CREDIT_CARD|WALLET|LOAN|INVESTMENT|INSURANCE|TAX|OTHER",
  "document_subtype": "<e.g., Savings, Current, Platinum Card>",
  "institution_name": "<detected institution>",
  "country": "India",
  "confidence_score": 0.95,

  "exclusion_markers": {{
    "patterns": ["pattern1", "pattern2", "..."]
  }},

  "parsing_hints": {{
    "layout_type": "SINGLE_COLUMN|TWO_COLUMN_PDF|MULTI_SECTION",
    "summary_section_labels": ["label1", "label2"],
    "transaction_boundary_signals": ["DATE"],
    "ref_no_pattern": "<regex or null>",
    "page_break_pattern": "Page \\\\d+ of \\\\d+",
    "details_strip_patterns": ["pattern1", "pattern2"],
    "known_summary_amounts": ["amount1", "amount2"]
  }},

  "identity_markers": {{
    "issuer_identity": {{
      "issuer_name": {{ "rule": "keyword", "patterns": ["exact name"] }},
      "regulatory_identifiers": {{
        "ifsc": {{ "rule": "regex", "pattern": "<regex or null>" }},
        "swift": {{ "rule": "regex", "pattern": "<regex or null>" }},
        "iban": {{ "rule": "regex", "pattern": "<regex or null>" }},
        "gstin": {{ "rule": "regex", "pattern": "<regex or null>" }},
        "other": []
      }}
    }},
    "document_structure_identity": {{
      "document_title_phrase": {{ "rule": "keyword", "patterns": ["EXACT TITLE"] }},
      "document_reference_number": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "generation_phrase": {{ "rule": "keyword", "patterns": ["Generated on", "Statement Date"] }}
    }},
    "period_identity": {{
      "statement_period": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "statement_date": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "billing_cycle": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "tax_period": {{ "rule": "regex", "pattern": "<regex or null>" }}
    }},
    "entity_identity": {{
      "account_number": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "masked_card_number": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "loan_account_number": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "customer_id": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "wallet_id": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "merchant_id": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "pan": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "bo_id": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "dp_id": {{ "rule": "regex", "pattern": "<regex or null>" }}
    }},
    "transaction_table_identity": {{
      "table_header_markers": ["Column1", "Column2", "Column3"],
      "minimum_column_count": 4,
      "presence_of_running_balance": true,
      "debit_credit_style": true
    }},
    "financial_summary_identity": {{
      "total_outstanding": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "minimum_due": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "emi_amount": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "credit_limit": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "drawing_power": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "portfolio_value": {{ "rule": "regex", "pattern": "<regex or null>" }},
      "total_tax": {{ "rule": "regex", "pattern": "<regex or null>" }}
    }},
    "footer_identity": {{
      "footer_markers": ["footer text pattern 1", "footer text pattern 2"]
    }}
  }}
}}

══════════════════════════════════════════════════════════════════════════════
CRITICAL OUTPUT RULES
══════════════════════════════════════════════════════════════════════════════
✓ Return ONLY the JSON object
✓ No markdown code blocks (no ```json```)
✓ No explanations before or after
✓ No comments in the JSON
✓ All regex patterns must use double backslashes (\\\\d not \\d)
✓ Set null for fields not applicable to the document type
✓ confidence_score must be between 0.0 and 1.0

BEGIN ANALYSIS OF THE PROVIDED FINANCIAL STATEMENT NOW.

Analyze this financial statement and generate identification markers:

{first_pages_text}
"""

    raw = call_llm(
        prompt=prompt,
        model=CLASSIFIER_MODEL,
        temperature=0
    )

    # ── Clean and parse the LLM JSON response ────────────────────────────────
    def _clean_json(s: str) -> str:
        s = re.sub(r"```(?:json)?", "", s).strip()   # strip markdown fences
        start = s.find("{")
        end   = s.rfind("}")
        if start != -1 and end != -1:
            s = s[start:end + 1]
        s = re.sub(r",\s*([\]}])", r"\1", s)          # trailing commas
        s = re.sub(r":\s*True\b",  ": true",  s)      # Python bool → JSON bool
        s = re.sub(r":\s*False\b", ": false", s)
        s = re.sub(r":\s*None\b",  ": null",  s)
        if s.count("{") > s.count("}"):                # auto-close open braces
            s += "}" * (s.count("{") - s.count("}"))
        return s

    try:
        identifier = json.loads(_clean_json(raw))
    except Exception as e:
        logger.error(
            "classify_document_llm: JSON parse failed — %s | raw_preview=%s",
            e, raw[:500],
        )
        m = re.search(r"(\{.*\})", raw, re.DOTALL)
        if m:
            try:
                identifier = json.loads(_clean_json(m.group(1)))
            except Exception:
                raise ValueError(f"LLM returned invalid JSON: {e}")
        else:
            raise ValueError(f"LLM returned no JSON-like content: {e}")

    # ── Ensure parsing_hints exists with safe defaults ────────────────────────
    if "parsing_hints" not in identifier:
        logger.warning("classify_document_llm: parsing_hints missing — injecting defaults")
        identifier["parsing_hints"] = {
            "layout_type":                  "SINGLE_COLUMN",
            "summary_section_labels":       [],
            "transaction_boundary_signals": ["DATE"],
            "ref_no_pattern":               None,
            "page_break_pattern":           r"Page \d+ of \d+",
            "details_strip_patterns":       [],
            "known_summary_amounts":        [],
        }
    else:
        ph = identifier["parsing_hints"]
        ph.setdefault("layout_type",                  "SINGLE_COLUMN")
        ph.setdefault("summary_section_labels",       [])
        ph.setdefault("transaction_boundary_signals", ["DATE"])
        ph.setdefault("ref_no_pattern",               None)
        ph.setdefault("page_break_pattern",           r"Page \d+ of \d+")
        ph.setdefault("details_strip_patterns",       [])
        ph.setdefault("known_summary_amounts",        [])

    # ── Normalise institution_name ────────────────────────────────────────────
    raw_inst = identifier.get("institution_name") or "Unknown"
    norm_inst = normalise_institution_name(raw_inst)

    # ── Heuristic Fallback for TJSB ───────────────────────────────────────────
    # TJSB statements often have no bank name in text, only a logo.
    # The concatenated string "SavingAccountStatement" or "TJSB" in text are markers.
    if norm_inst == "UNKNOWN":
        header_text = "\n".join(pages[:2]).lower().replace(" ", "")
        if "savingaccountstatement" in header_text or "tjsb" in header_text:
            logger.info("classify_document_llm: TJSB heuristic match triggered")
            norm_inst = "TJSB SAHAKARI BANK"
            if identifier.get("id"):
                identifier["id"] = identifier["id"].replace("UNKNOWN", "TJSB")

    identifier["institution_name"] = norm_inst

    logger.info(
        "classify_document_llm: family=%s  institution=%s (raw=%r)  "
        "layout=%s  id=%s",
        identifier.get("document_family"),
        identifier.get("institution_name"),
        raw_inst,
        identifier.get("parsing_hints", {}).get("layout_type"),
        identifier.get("id"),
    )

    return identifier


# ════════════════════════════════════════════════════════════
# SAVE NEW FORMAT  [UNTOUCHED]
# ════════════════════════════════════════════════════════════

def derive_statement_type(identifier_json: dict) -> str:
    family   = identifier_json.get("document_family", "UNKNOWN")
    type_map = {
        "BANK_ACCOUNT_STATEMENT":          "BANK_STATEMENT",
        "CREDIT_CARD_STATEMENT":           "CREDIT_CARD",
        "LOAN_STATEMENT":                  "LOAN",
        "WALLET_STATEMENT":                "WALLET",
        "INVESTMENT_STATEMENT":            "INVESTMENT",
        "DEMAT_STATEMENT":                 "DEMAT",
        "TAX_LEDGER_STATEMENT":            "TAX_LEDGER",
        "PAYMENT_GATEWAY_SETTLEMENT":      "PAYMENT_GATEWAY",
        "OVERDRAFT_CASH_CREDIT_STATEMENT": "OD_CC",
    }
    return type_map.get(family, family)


def save_new_statement_format(
    format_name: str,
    identifier_json: dict,
    extraction_logic: str,
    threshold: float = 65.0,
) -> int:
    statement_type  = derive_statement_type(identifier_json)
    document_family = identifier_json.get("document_family", "UNKNOWN")

    # Always normalise before save — safety net for any caller that bypasses
    # classify_document_llm (e.g. tests or future code paths).
    raw_name         = identifier_json.get("institution_name") or "Unknown"
    institution_name = normalise_institution_name(raw_name)

    # Write normalised name back so the stored identifier_json is consistent
    # with the institution_name column value.
    identifier_json = {**identifier_json, "institution_name": institution_name}

    # ── Dedup guard ───────────────────────────────────────────────────────────
    existing = check_format_exists(identifier_json)
    if existing:
        logger.info(
            "save_new_statement_format: dedup hit — returning existing statement_id=%s "
            "(institution=%s  family=%s)",
            existing["statement_id"], institution_name, document_family,
        )
        return existing["statement_id"]

    # Extract IFSC from the identity markers if present
    # (the LLM stores it in identity_markers.issuer_identity.regulatory_identifiers.ifsc)
    ifsc_code = None
    try:
        ifsc_pattern = (
            identifier_json
            .get("identity_markers", {})
            .get("issuer_identity", {})
            .get("regulatory_identifiers", {})
            .get("ifsc", {})
            .get("pattern")
        )
        if ifsc_pattern:
            import re as _re
            # The pattern is a regex — extract the IFSC prefix (first 4 letters)
            m = _re.search(r"([A-Z]{4})", str(ifsc_pattern))
            if m:
                ifsc_code = m.group(1)
    except Exception:
        pass

    logger.info(
        "Saving NEW format: name=%s  type=%s  institution=%s  ifsc=%s",
        format_name, statement_type, institution_name, ifsc_code,
    )
    return insert_statement_category(
        statement_type=statement_type,
        format_name=format_name,
        institution_name=institution_name,
        identifier_json=identifier_json,
        extraction_logic=extraction_logic,
        ifsc_code=ifsc_code,
        threshold=threshold,
    )