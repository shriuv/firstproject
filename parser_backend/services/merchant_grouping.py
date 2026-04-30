import os
import re
import uuid
import math
import logging
import time
import httpx

from db.connection import get_client

logger = logging.getLogger("ledgerai.ledger_merchants")

# ── Configuration ─────────────────────────────────────────────────────────────
COSINE_THRESHOLD_GROUP  = 0.92
EMBED_BATCH_SIZE   = 50  # Increased batch size for the ML service

# ==============================================================================
# UNIVERSAL SIGNAL REGISTRY v19 (Omni-Note / Tail Rescue)
# ==============================================================================

# HARD_NOISE: Absolute institutional blackout.
HARD_NOISE = {
    'UPI', 'UPIOUT', 'UPIIN', 'DR', 'CR', 'IMPS', 'NEFT', 'RTGS', 'APBS', 'CWDR',
    'INW', 'OUT', 'SENT', 'RECEIVED', 'PAYMENT', 'TRANSFER', 'VIA', 'AT', 'REF',
    'NO', 'RRN', 'TIME', 'SGST', 'CGST', 'VAT', 'VALUE', 'DT', 'DATE', 'ACH', 
    'OFFICE', 'EXPENSES', 'BRANCH', 'LOC', 'STA', 'TO', 'FROM', 'NUMBER', 'TRANS', 'TXN',
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
    'INDIA', 'LTD', 'PVT', 'PRIVATE', 'LIMITED', 'INC', 'CORP', 'LLP', 'CO', 'UNIT', 'OF',
    'HDFC', 'ICICI', 'YES', 'SBI', 'AXIS', 'KOTAK', 'YESBANK', 'CANARA', 'INDUSIND', 
    'OKHDFCBANK', 'OKAXIS', 'OKSBI', 'OKBIZAXI', 'AXL', 'YBL', 'IBL', 'AXISB', 'YESB', 
    'PTM', 'PTY', 'PTYBL', 'PYM', 'PAYM', 'RZP', 'FDRL', 'CBIN', 'AUBL', 'BKID', 'UTIB',
    'KBIZAXIS', 'YESBPTMUPI', 'SBYBLUPI', 'SBMCHUPI', 'YESBYBLUPI', 'PTMUPI', 'PTYS'
}

# SOFT_NOISE: Rescued only if zero primary signal exists.
SOFT_NOISE = {
    'FEE', 'CHARGE', 'CHG', 'SBINT', 'INTEREST', 'WAIVER', 'CUST', 'ID', 'MOB', 
    'ALRT', 'SMS', 'CASH', 'WDL', 'ATM', 'BIL', 'ONL', 'BBPS', 'IND', 'DUBLIN', 'IE', 
    'VPA', 'IFSC', 'BANK', 'MOBILE', 'PHON', 'GST'
}

# MERCHANT_ANCHORS: Protected high-signal tokens.
MERCHANT_ANCHORS = {
    'AMAZON', 'SWIGGY', 'ZOMATO', 'NETFLIX', 'SPOTIFY', 'AIRTEL', 'JIO', 'JIOMART',
    'BLINKIT', 'ZEPTO', 'MYNTRA', 'FLIPKART', 'PAYTM', 'PHONEPE', 'GPAY', 'IRCTC',
    'CASHBACK', 'EARNED', 'PLAYSTORE', 'MUKHYAMANTRI', 'LADKI', 'MAZI', 'LA', 
    'TEA', 'MILK', 'RENT', 'FOOD', 'TRAVEL', 'GROCERY', 'FUEL', 'STORES', 'SWEETS',
    'PRINTS', 'BREAKFAST', 'BAKERY', 'AUTO'
}

def _derive_clean_string_no_rule(details: str) -> str:
    """
    Survivor Identity Engine v19: Omni-Note.
    Explicitly rescues the LAST non-noise word (The Note) from the narration.
    """
    if not details:
        return "UNKNOWN"

    raw = str(details).upper()
    
    # 1. Structural Regex Purge
    raw = re.sub(r"\b20[2-3]\d\b", " ", raw) 
    raw = re.sub(r"\b\d{1,2}[/\-\.]\d{1,2}[/\-\.](\d{2}|\d{4})\b", " ", raw)
    raw = re.sub(r"\b\d{2}:\d{2}(:\d{2})?\b", " ", raw) 
    raw = re.sub(r"\b\d{4,}\b", " ", raw) 
    
    # 2. Syllabic Tokenization (The Signal Hunt)
    raw = re.sub(r"[@/:_\-\*\+\|.]", " ", raw)
    candidates = raw.split()
    
    primary_segments = []
    secondary_segments = []

    for w in candidates:
        w = w.strip(".*()/,")
        
        # Identity Protection
        if w in MERCHANT_ANCHORS:
            if w not in primary_segments: primary_segments.append(w)
            continue

        # Hard Blackout check (including prefix matching and Bank-ID regex)
        # Regex kills fragments like UTIB0000553, ICIC00006534
        if w in HARD_NOISE or any(w.startswith(noise) for noise in ['HDFC', 'ICICI', 'SBI', 'AXIS', 'OK', 'PAYTM']):
            continue
        if re.match(r'^[A-Z]{4}\d+', w): # Kill IFSCs
            continue
        
        if w in SOFT_NOISE:
            if w not in secondary_segments: secondary_segments.append(w)
            continue
            
        # Signal Guardian: Min 3-char alphabetic kernel
        alpha_only = "".join([c for c in w if c.isalpha()])
        if len(alpha_only) < 3 or alpha_only in HARD_NOISE:
            continue
        w = alpha_only

        # Aggressive Prefix Character Dedup
        is_redundant = False
        for seen in primary_segments:
            if w == seen: 
                is_redundant = True; break
            if len(w) >= 4 and len(seen) >= 4:
                prefix = w[:4]
                if seen.startswith(prefix) or w.startswith(seen[:4]):
                    is_redundant = True; break
        
        if is_redundant: continue
        primary_segments.append(w)

    # 3. Identity Synthesis (Omni-Note Restoration)
    if not primary_segments:
        final = secondary_segments
    else:
        identity = primary_segments[:2]
        note = primary_segments[-1]
        if note not in identity:
            identity.append(note)
        final = identity
    
    if not final:
        potential = [w.strip(".*()/,") for w in candidates if len(w) > 3 and not w.isdigit() and w not in HARD_NOISE]
        if potential:
            best = sorted(potential, key=len, reverse=True)[0]
            if len("".join([c for c in best if c.isalpha()])) >= 3: return best
        return "UNKNOWN"

    return " ".join(final[:3]).strip()

def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(x * x for x in b))
    if mag_a == 0 or mag_b == 0: return 0.0
    return dot / (mag_a * mag_b)

def _get_ml_service_url() -> str:
    url = os.environ.get("ML_SERVICE_URL", "").strip()
    if not url: return f"http://127.0.0.1:{os.environ.get('PYTHON_PORT', '5000')}"
    return url

def _embed_batch(client: httpx.Client, clean_strings: list[str]) -> list[list[float] | None]:
    """Uses the ML service's batch endpoint for efficiency."""
    ml_url = _get_ml_service_url()
    endpoint = f"{ml_url}/embed/batch"
    try:
        resp = client.post(endpoint, json={"texts": clean_strings}, timeout=60.0)
        resp.raise_for_status()
        results = resp.json().get("results", [])
        return [r.get("embedding") for r in results]
    except Exception as e:
        logger.error("Batch embedding failed: %s", e)
        # Fallback to individual calls if batch fails for some reason
        fallback = []
        individual_endpoint = f"{ml_url}/embed"
        for text in clean_strings:
            try:
                r = client.post(individual_endpoint, json={"text": text.upper()}, timeout=30.0)
                r.raise_for_status()
                fallback.append(r.json().get("embedding"))
            except:
                fallback.append(None)
        return fallback

def _classify_transactions(txns: list[dict], routing_rules: list[dict]) -> list[dict]:
    for txn in txns:
        details = (txn.get("details") or "").upper().strip()
        txn["clean_string"] = _derive_clean_string_no_rule(details)
        matched = False
        for rule in routing_rules:
            if re.search(rule.get("pattern", ""), details, re.IGNORECASE):
                txn["pre_pipeline_strategy"] = rule.get("strategy_type", "")
                matched = True
                break
        if not matched: txn["pre_pipeline_strategy"] = "NO_RULE"
    return txns

def _group_within_batch(embed_txns: list[dict]) -> list[dict]:
    n = len(embed_txns)
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            if embed_txns[rx]["uncategorized_transaction_id"] <= embed_txns[ry]["uncategorized_transaction_id"]: parent[ry] = rx
            else: parent[rx] = ry
    
    # Pre-calculate embeddings for speed
    embs = [t.get("embedding") for t in embed_txns]
    
    for i in range(n):
        if not embs[i]: continue
        for j in range(i + 1, n):
            if not embs[j]: continue
            if _cosine_similarity(embs[i], embs[j]) >= COSINE_THRESHOLD_GROUP: 
                union(i, j)
                
    uuids: dict[int, str] = {}
    for i in range(n):
        root = find(i)
        if root not in uuids: uuids[root] = str(uuid.uuid4())
        embed_txns[i]["group_id"] = uuids[root]
    return embed_txns

def run_merchant_grouping(document_id: int, user_id: str) -> None:
    sb = get_client()
    logger.info("GROUPING START | document_id=%s", document_id)
    
    txns = sb.table("uncategorized_transactions").select("*").eq("document_id", document_id).eq("user_id", user_id).execute().data or []
    if not txns:
        sb.table("documents").update({"grouping_status": "done"}).eq("document_id", document_id).execute()
        return

    rules = sb.table("routing_rules").select("pattern, strategy_type").execute().data or []
    txns = _classify_transactions(txns, rules)
    
    strat_groups = {"FAST_PATH":[], "EXACT_THEN_DUMP":[], "VECTOR_SEARCH":[], "NO_RULE":[]}
    for t in txns: strat_groups[t["pre_pipeline_strategy"]].append(t)
    
    # Batch update strategy labels
    for strat, group in strat_groups.items():
        if not group: continue
        ids = [t["uncategorized_transaction_id"] for t in group]
        payload = {"pre_pipeline_strategy": strat}
        if strat in ("FAST_PATH", "EXACT_THEN_DUMP"): payload["grouping_status"] = "skipped"
        sb.table("uncategorized_transactions").update(payload).in_("uncategorized_transaction_id", ids).execute()

    embed_txns = strat_groups["VECTOR_SEARCH"] + strat_groups["NO_RULE"] + strat_groups["EXACT_THEN_DUMP"]
    if not embed_txns:
        _finish(sb, document_id, txns, user_id)
        return

    # ── 4. Collect Embeddings ──────────────────────────────────────────────────
    all_clean = [t["clean_string"] for t in embed_txns]
    embeddings = []
    
    with httpx.Client(follow_redirects=True, timeout=120.0) as client:
        for i in range(0, len(all_clean), EMBED_BATCH_SIZE):
            batch = all_clean[i : i + EMBED_BATCH_SIZE]
            logger.info("Fetching batch of %d embeddings...", len(batch))
            embeddings.extend(_embed_batch(client, batch))

        # ── 5. Update Database ────────────────────────────────────────────────
        logger.info("Updating %d embeddings in DB...", len(embeddings))
        for txn, emb in zip(embed_txns, embeddings):
            if not emb: continue
            
            txn["embedding"] = emb
            try:
                # We MUST exclude the identity column (uncategorized_transaction_id) from the update body
                # to avoid "cannot insert a non-DEFAULT value" errors on GENERATED ALWAYS columns.
                sb.table("uncategorized_transactions").update({
                    "embedding": emb,
                    "clean_merchant_name": txn["clean_string"]
                }).eq("uncategorized_transaction_id", txn["uncategorized_transaction_id"]).execute()
                
                # Small sleep to prevent overwhelming the connection pool/DB
                time.sleep(0.01) 
            except Exception as e:
                logger.error(f"Failed to update embedding for txn {txn.get('uncategorized_transaction_id')}: {e}")

        # ── 6. Perform Grouping ────────────────────────────────────────────────
        embedded_rows = [t for t in embed_txns if t.get("embedding")]
        if embedded_rows:
            logger.info("Grouping %d embedded transactions...", len(embedded_rows))
            embedded_rows = _group_within_batch(embedded_rows)
            
            logger.info("Updating %d group IDs in DB...", len(embedded_rows))
            for t in embedded_rows:
                try:
                    sb.table("uncategorized_transactions").update({
                        "group_id": t["group_id"]
                    }).eq("uncategorized_transaction_id", t["uncategorized_transaction_id"]).execute()
                    time.sleep(0.01)
                except Exception as e:
                    logger.error(f"Failed to update group_id for txn {t.get('uncategorized_transaction_id')}: {e}")
    
    _finish(sb, document_id, txns, user_id)

def _finish(sb, doc_id, txns, user_id):
    ids = [t["uncategorized_transaction_id"] for t in txns]
    if ids:
        sb.table("uncategorized_transactions").update({"grouping_status": "done"}).in_("uncategorized_transaction_id", ids).execute()
    
    sb.table("documents").update({"grouping_status": "pipeline_running", "updated_at": "now()"}).eq("document_id", doc_id).execute()
    
    time.sleep(1) # Reduced from 2s
    
    node_url = os.environ.get("NODE_BACKEND_URL", "http://127.0.0.1:3000")
    secret = os.environ.get("INTERNAL_SECRET", "")
    if secret:
        logger.info("Triggering Node.js auto-pipeline for doc %s...", doc_id)
        try:
            with httpx.Client() as client:
                client.post(
                    f"{node_url}/internal/auto-pipeline", 
                    json={"document_id": doc_id, "user_id": user_id}, 
                    headers={"Authorization": f"Bearer {secret}"}, 
                    timeout=120.0
                )
        except Exception as e:
            logger.error("Failed to trigger Node.js pipeline: %s", e)
