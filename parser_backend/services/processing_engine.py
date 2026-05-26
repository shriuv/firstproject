import json
import logging
import re

from services.pdf_service import extract_pdf_text
from services.identifier_service import (
    classify_document_llm,
    check_format_exists,
    save_new_statement_format,
)
from services.extraction_service import (
    generate_extraction_logic_llm,
    extract_transactions_using_logic,
    refine_extraction_logic_llm,
    _analyze_mismatches_deep,
    _diagnose_code_bugs,
    _build_line_examples,
)
from services.llm_parser import parse_with_llm
from db.connection import get_client
from services.validation_service import (
    validate_transactions,
    extract_json_from_response,
    validate_extraction_propriety,
)
from repository.document_repo import (
    get_document,
    get_document_password,
    update_processing_start,
    update_document_status,
    insert_audit,
    insert_text_extraction,
    update_document_statement,
    update_processing_complete,
    insert_staging_transactions,
    insert_staging_code_only,
    get_text_extraction,
)
from repository.statement_category_repo import (
    activate_statement_category,
    update_statement_status,
    update_success_rate,
    get_statement_by_id,
    update_extraction_logic,
)

logger = logging.getLogger("ledgerai.processing_engine")

MAX_VETTING_RETRIES = 3


# ═══════════════════════════════════════════════════════════
# VETTING LOOP — Shared by Case A (EXPERIMENTAL) and Case B (NEW)
# ═══════════════════════════════════════════════════════════

def _run_vetting_loop(
    extraction_code: str,
    vetting_text: str,
    identity_json: dict,
    sample_text: str,
    statement_id: int = None,
) -> tuple[str, list]:
    """
    Run the LLM parser on vetting pages (pages 1-2) to get ground truth,
    then compare against the generated extraction code.
    If the code is inaccurate, send feedback to the LLM and improve the code.
    Returns (best_code, llm_ground_truth).

    The LLM is ONLY called once per vetting run (for ground truth).
    Improvement attempts only cost code-gen calls, not LLM-parse calls.
    """
    # ── 1. Get LLM ground truth (single LLM parse call) ───────────────────────
    logger.info("[VET] Running LLM parser on vetting pages (single call)...")
    try:
        gt_response  = parse_with_llm(vetting_text, identity_json)
        ground_truth = extract_json_from_response(gt_response)
        logger.info("[VET] Ground truth: %d transactions", len(ground_truth))
    except Exception as e:
        logger.warning("[VET] Ground truth extraction failed: %s — skipping vetting.", e)
        return extraction_code, []

    if not ground_truth:
        logger.info("[VET] Ground truth is empty — skipping vetting loop.")
        return extraction_code, []

    # ── 2. Run current code on vetting pages ──────────────────────────────────
    try:
        init_results = extract_transactions_using_logic(vetting_text, extraction_code)
    except Exception as e:
        init_results = []
        logger.warning("[VET] Initial code run failed: %s", e)

    init_metrics  = validate_transactions(init_results, ground_truth)
    init_accuracy = init_metrics.get("overall_accuracy", 0) if init_metrics else 0
    init_count_ok = len(init_results) == len(ground_truth)

    logger.info(
        "[VET] Initial: %d extracted / %d expected | accuracy=%.1f%%",
        len(init_results), len(ground_truth), init_accuracy,
    )

    # ── 3. Skip improvement if already accurate ───────────────────────────────
    if init_accuracy >= 98 and init_count_ok:
        logger.info("[VET] Code is already highly accurate — skipping improvement.")
        return extraction_code, ground_truth

    # ── 4. Improvement loop ───────────────────────────────────────────────────
    logger.info(
        "[VET] Code needs improvement (accuracy=%.1f%%) — starting improvement loop...",
        init_accuracy,
    )

    # Build initial mismatch analysis
    try:
        mismatch_rows = _analyze_mismatches_deep(init_results, ground_truth)
        bug_rows      = _diagnose_code_bugs(init_results, ground_truth, vetting_text)
        line_maps     = _build_line_examples(ground_truth, vetting_text)
        mismatch_analysis = (
            f"Initial run: {len(init_results)} extracted / {len(ground_truth)} expected.\n\n"
            f"BUG DIAGNOSIS:\n{bug_rows}\n\n"
            f"MISMATCH ANALYSIS:\n{mismatch_rows}\n\n"
            f"LINE MAPPINGS:\n{line_maps}\n\n"
            f"GROUND TRUTH:\n{json.dumps(ground_truth[:20], indent=2)}\n\n"
            f"CODE OUTPUT:\n{json.dumps(init_results[:20], indent=2)}"
        )
    except Exception as e:
        mismatch_analysis = f"Code crashed on initial run: {e}. Fix all errors."

    best_code = refine_extraction_logic_llm(
        current_logic     = extraction_code,
        mismatch_analysis = mismatch_analysis,
        text_sample       = sample_text,
        ground_truth      = ground_truth,
        first_page_text   = vetting_text,
        statement_id      = statement_id,
    )

    return best_code, ground_truth


# ═══════════════════════════════════════════════════════════
# MAIN PIPELINE
# ═══════════════════════════════════════════════════════════

def process_document(
    document_id: int,
    override_file_path: str = None,
    retry_mode: str = "AUTO",
    retry_note: str = None,
):
    """
    Main entry point. Called after document is inserted into DB.

    Pipeline:
      STEP 1 — Fetch document
      STEP 2 — Extract text from PDF
      STEP 3 — Identify format
      STEP 3b — Load or generate extraction code
      STEP 3c — Vetting loop (LLM ground truth + code improvement on pages 1-2)
      STEP 3d — Save new format to DB (Case B only)
      STEP 4  — Full-document extraction (code + LLM)
      STEP 5  — Validate & decide winner

    Case A (ACTIVE):   fast-path, no vetting, code only.
    Case B (EXPERIMENTAL/UNDER_REVIEW): vetting loop before full run.
    Case C (NEW format): generate code, run vetting loop, save, then full run.
    """

    try:
        # ─────────────────────────────────────────────────────
        # STEP 1 — FETCH DOCUMENT
        # ─────────────────────────────────────────────────────
        logger.info("")
        logger.info("═" * 70)
        logger.info("  PIPELINE START — document_id=%s", document_id)
        logger.info("═" * 70)

        doc = get_document(document_id)
        if not doc:
            raise ValueError(f"Document {document_id} not found.")

        file_path = override_file_path or doc["file_path"]
        user_id   = doc["user_id"]
        password  = get_document_password(document_id)

        logger.info("[STEP 1/5] Document fetched")
        logger.info("file      : %s", doc["file_name"])
        logger.info("path      : %s", file_path)
        logger.info("user_id   : %s", user_id)
        logger.info("password  : %s", "YES" if password else "NO")
        logger.info("═" * 70)

        update_processing_start(document_id)
        insert_audit(document_id, "EXTRACTING_TEXT", f"Mode: {retry_mode}")

        # Cleanup old staging rows if this is a retry
        if retry_mode != "AUTO":
            sb = get_client()
            sb.table("ai_transactions_staging").delete().eq("document_id", document_id).execute()

        # ─────────────────────────────────────────────────────
        # STEP 2 — EXTRACT TEXT FROM PDF
        # ─────────────────────────────────────────────────────
        logger.info("")
        logger.info("[STEP 2/5] Extracting text from PDF...")
        update_document_status(document_id, "EXTRACTING_TEXT")

        full_text = None
        if retry_mode != "AUTO":
            full_text = get_text_extraction(document_id)

        if full_text:
            logger.info("Found existing text extraction in DB — skipping PDF extraction")
        else:
            full_text = extract_pdf_text(file_path, password)
            if not full_text:
                raise ValueError("PDF extraction returned empty text.")
            insert_text_extraction(document_id, full_text)

        sample_text = full_text[:20000]

        # Split full_text into per-page list
        pages = [
            block.strip()
            for block in re.split(r'={80}', full_text)
            if block.strip() and not re.fullmatch(r'\s*PAGE\s+\d+\s*', block.strip(), re.IGNORECASE)
        ]
        if not pages:
            pages = [full_text]

        logger.info("pages     : %d", len(pages))
        logger.info("chars     : %d", len(full_text))
        logger.info("Text handled successfully")
        logger.info("═" * 70)

        if retry_mode == "MANUAL":
            logger.info("MANUAL mode — skipping automatic extraction")
            update_document_status(document_id, "AWAITING_REVIEW")
            insert_staging_code_only(document_id, user_id, [], 1.0)
            insert_audit(document_id, "COMPLETED", "Manual entry requested: " + (retry_note or ""))
            return

        update_document_status(document_id, "IDENTIFYING_FORMAT")

        # ─────────────────────────────────────────────────────
        # STEP 3 — IDENTIFY FORMAT
        # ─────────────────────────────────────────────────────
        logger.info("")
        logger.info("[STEP 3/5] Identifying statement format...")

        existing         = None
        identity_json    = None
        statement_id     = None
        statement_status = None

        # On retries, reuse the existing statement_id if already linked
        if retry_mode != "AUTO" and doc.get("statement_id"):
            existing = get_statement_by_id(doc["statement_id"])
            if existing:
                identity_json = existing.get("statement_identifier", {})
                logger.info("REUSING IDENTIFICATION: linked statement_id=%s", doc["statement_id"])

        if not existing:
            logger.info("Generating identification markers via LLM...")
            identity_json = classify_document_llm(pages)
            logger.info("Identification generated: %s", identity_json.get("id"))
            logger.info("Checking if format exists in database...")
            existing = check_format_exists(identity_json)

        matched = existing is not None

        if matched:
            logger.info("EXISTING FORMAT DETECTED")
            logger.info("format    : %s", existing.get("format_name", "?"))
            logger.info("statement : %s", existing.get("statement_id"))
            logger.info("status    : %s", existing.get("status"))
        else:
            logger.info("NO MATCHING FORMAT — new format will be generated")
        logger.info("═" * 70)

        update_document_status(document_id, "PARSING_TRANSACTIONS")

        # ── Pages 1-2 text used as vetting surface ─────────────────────────────
        vetting_text = "\n\n".join(pages[:2]) if pages else full_text

        # ─────────────────────────────────────────────────────
        # CASE A — ACTIVE FORMAT → Fast-path (no vetting needed)
        # ─────────────────────────────────────────────────────
        if matched and existing.get("status") == "ACTIVE":
            identity_json    = existing.get("statement_identifier", {})
            extraction_code  = existing["extraction_logic"]
            statement_id     = existing["statement_id"]
            statement_status = "ACTIVE"

            update_document_statement(document_id, statement_id)

            # # Handle user-triggered code retry with feedback note
            # if retry_mode == "CODE" and retry_note and extraction_code:
            #     try:
            #         logger.info("CODE RETRY: Applying user feedback to improve logic...")
            #         refined_code = refine_extraction_logic_llm(
            #             current_logic     = extraction_code,
            #             mismatch_analysis = retry_note,
            #             text_sample       = sample_text,
            #         )
            #         if refined_code:
            #             update_extraction_logic(statement_id, refined_code)
            #             extraction_code = refined_code
            #             logger.info("CODE RETRY: Logic updated successfully.")
            #     except Exception as e:
            #         logger.warning("CODE RETRY: Failed: %s", e)

            logger.info("")
            logger.info("[STEP 4/5] ACTIVE format — fast-path code extraction...")

            code_txns = extract_transactions_using_logic(full_text, extraction_code)
            logger.info("Code extracted: %d transactions", len(code_txns))

            # For ACTIVE formats the code has already been vetted and promoted.
            # We trust it completely — strict gate is NOT applied here.
            propriety_ok = validate_extraction_propriety(code_txns)

            if propriety_ok:
                logger.info("[STEP 5/5] PIPELINE COMPLETE — CODE (ACTIVE fast-path)")
                update_processing_complete(document_id, "CODE")
                insert_staging_code_only(document_id, user_id, code_txns, 100.0)
                update_document_status(document_id, "AWAITING_REVIEW")
                insert_audit(document_id, "COMPLETED")
                logger.info("═" * 70)
                return

            # Propriety check failed (e.g. noise rows) — fall into dual pipeline
            # without changing the ACTIVE status on the format.
            logger.warning(
                "ACTIVE code failed propriety check — "
                "falling into dual pipeline without status demotion."
            )

            # No vetting loop for ACTIVE — just run LLM on full doc
            llm_ground_truth = []
            try:
                llm_response = parse_with_llm(full_text, identity_json)
                llm_txns     = extract_json_from_response(llm_response)
                logger.info("LLM extraction complete: %d transactions", len(llm_txns))
            except Exception as e:
                logger.error("LLM extraction FAILED: %s", e)
                llm_txns = []

            _finish_pipeline(
                document_id=document_id,
                user_id=user_id,
                statement_id=statement_id,
                statement_status=statement_status,
                extraction_code=extraction_code,
                code_txns=code_txns,
                llm_txns=llm_txns,
            )
            return

        # ─────────────────────────────────────────────────────
        # STEP 3b — LOAD OR GENERATE EXTRACTION CODE
        # ─────────────────────────────────────────────────────
        is_new_format = not matched

        if matched:
            # Case B — EXPERIMENTAL / UNDER_REVIEW
            identity_json    = existing.get("statement_identifier", {})
            extraction_code  = existing["extraction_logic"]
            statement_id     = existing["statement_id"]
            statement_status = existing.get("status")
            update_document_statement(document_id, statement_id)
            logger.info(
                "[STEP 3b/5] Loaded existing extraction code for %s format (statement_id=%s)",
                statement_status, statement_id,
            )
        else:
            # Case C — New format
            logger.info("")
            logger.info("[STEP 3b/5] Generating initial extraction code via LLM...")
            extraction_code = generate_extraction_logic_llm(identity_json, sample_text)
            logger.info("Initial extraction code generated (%d chars)", len(extraction_code))
            statement_id     = None
            statement_status = "UNDER_REVIEW"

        # ─────────────────────────────────────────────────────
        # STEP 3c — VETTING LOOP (pages 1-2)
        # Run LLM once to get ground truth, improve code if needed
        # ─────────────────────────────────────────────────────
        logger.info("")
        logger.info("[STEP 3c/5] Running vetting loop on pages 1-2...")

        extraction_code, llm_ground_truth = _run_vetting_loop(
            extraction_code = extraction_code,
            vetting_text    = vetting_text,
            identity_json   = identity_json,
            sample_text     = sample_text,
            statement_id    = statement_id,  
        )

        logger.info(
            "[STEP 3c/5] Vetting complete. Final code: %d chars | Ground truth: %d txns",
            len(extraction_code), len(llm_ground_truth),
        )

        # ─────────────────────────────────────────────────────
        # STEP 3d — SAVE NEW FORMAT (Case C only)
        # Note: save_new_statement_format internally deduplicates —
        # no need to call check_format_exists again here.
        # ─────────────────────────────────────────────────────
        if is_new_format:
            logger.info("")
            logger.info("[STEP 3d/5] Saving new format to database...")
            statement_id = save_new_statement_format(
                format_name      = identity_json.get("id", "AUTO_FORMAT"),
                identifier_json  = identity_json,
                extraction_logic = extraction_code,
            )
            update_document_statement(document_id, statement_id)
            statement_status = "UNDER_REVIEW"
            logger.info("Saved as statement_id=%s (UNDER_REVIEW)", statement_id)
        else:
            # For existing formats with improved code — update DB immediately
            if extraction_code != existing.get("extraction_logic", ""):
                logger.info("[STEP 3c/5] Updating improved code in DB (statement_id=%s)...", statement_id)
                update_extraction_logic(statement_id, extraction_code)

        # ─────────────────────────────────────────────────────
        # STEP 4 — FULL DOCUMENT EXTRACTION
        # ─────────────────────────────────────────────────────
        logger.info("")
        logger.info("[STEP 4/5] Running full-document extraction (mode=%s)...", retry_mode)

        code_txns = []
        llm_txns  = []

        # ── CODE-ONLY RETRY ──
        if retry_mode == "CODE":
            try:
                code_txns = extract_transactions_using_logic(full_text, extraction_code)
                logger.info("CODE extraction complete: %d transactions", len(code_txns))
            except Exception as e:
                logger.error("CODE extraction FAILED: %s", e)

            update_processing_complete(document_id, "CODE")
            insert_staging_code_only(document_id, user_id, code_txns, 100.0)
            update_document_status(document_id, "AWAITING_REVIEW")
            insert_audit(document_id, "COMPLETED", "Code-only retry")
            logger.info("═" * 70)
            return

        # ── VISION RETRY ──
        if retry_mode == "VISION":
            logger.info("[STEP 4v/5] Running VISION EXTRACTION (Multimodal)...")
            from services.llm_parser import parse_with_vision
            try:
                with open(file_path, "rb") as f:
                    pdf_bytes = f.read()
                vision_response = parse_with_vision(pdf_bytes, identity_json, retry_note)
                llm_txns = extract_json_from_response(vision_response)
                logger.info("VISION extraction complete: %d transactions", len(llm_txns))

                if llm_txns:
                    update_processing_complete(document_id, "LLM")
                    insert_staging_transactions(
                        document_id=document_id, user_id=user_id,
                        code_txns=[], llm_txns=llm_txns,
                        code_confidence=0.0, llm_confidence=0.9,
                    )
                    update_document_status(document_id, "AWAITING_REVIEW")
                    insert_audit(document_id, "COMPLETED", "Vision extraction: " + (retry_note or ""))
                    return
            except Exception as e:
                logger.error("VISION extraction FAILED: %s — falling through", e)

        # ── STANDARD DUAL PIPELINE ──
        # CODE: always run on full document
        try:
            code_txns = extract_transactions_using_logic(full_text, extraction_code)
            logger.info("CODE extraction complete: %d transactions", len(code_txns))
        except Exception as e:
            logger.warning("CODE extraction FAILED: %s", e)

        # LLM: reuse pages 1-2 ground truth from vetting, only fetch remaining pages
        if llm_ground_truth and len(pages) <= 2:
            # Short doc — vetting covered all pages, no extra LLM call
            llm_txns = llm_ground_truth
            logger.info(
                "LLM extraction: reusing vetting cache — %d txns (%d-page doc, no extra call)",
                len(llm_txns), len(pages),
            )
        elif llm_ground_truth and len(pages) > 2:
            # Long doc — vetting covered pages 1-2, fetch the rest
            logger.info(
                "LLM extraction: reusing pages 1-2 cache, fetching pages 3-%d...", len(pages),
            )
            remaining_text = "\n\n".join(pages[2:])
            try:
                remaining_response = parse_with_llm(remaining_text, identity_json)
                remaining_txns     = extract_json_from_response(remaining_response)
                llm_txns = llm_ground_truth + remaining_txns
                logger.info(
                    "LLM extraction complete: %d cached + %d remaining = %d total",
                    len(llm_ground_truth), len(remaining_txns), len(llm_txns),
                )
            except Exception as e:
                logger.error("LLM remaining pages FAILED: %s — using cache only", e)
                llm_txns = llm_ground_truth
        else:
            # No vetting cache (e.g. ACTIVE fallthrough) — full LLM parse
            logger.info("LLM extraction: no cache — parsing full document...")
            try:
                llm_response = parse_with_llm(full_text, identity_json)
                llm_txns     = extract_json_from_response(llm_response)
                logger.info("LLM extraction complete: %d transactions", len(llm_txns))
            except Exception as e:
                logger.error("LLM extraction FAILED: %s", e)

        logger.info("Results: CODE=%d txns | LLM=%d txns", len(code_txns), len(llm_txns))

        # ─────────────────────────────────────────────────────
        # STEP 5 — VALIDATE & DECIDE WINNER
        # ─────────────────────────────────────────────────────
        _finish_pipeline(
            document_id      = document_id,
            user_id          = user_id,
            statement_id     = statement_id,
            statement_status = statement_status,
            extraction_code  = extraction_code,
            code_txns        = code_txns,
            llm_txns         = llm_txns,
        )

    except Exception as e:
        logger.error("")
        logger.error("PIPELINE FAILED for document_id=%s", document_id)
        logger.error("Error: %s", e, exc_info=True)
        logger.error("═" * 70)
        try:
            sb = get_client()
            sb.table("documents").update({"status": "FAILED", "pipeline_error": str(e)}).eq("document_id", document_id).execute()
            insert_audit(document_id, "FAILED", str(e))
        except Exception:
            logger.error("Failed to update failure status for doc %s", document_id, exc_info=True)
        raise


# ═══════════════════════════════════════════════════════════
# SHARED FINALISER — Validate, decide winner, persist results
# ═══════════════════════════════════════════════════════════

def _finish_pipeline(
    document_id: int,
    user_id: str,
    statement_id: int,
    statement_status: str,
    extraction_code: str,
    code_txns: list,
    llm_txns: list,
):
    logger.info("")
    logger.info("[STEP 5/5] VALIDATION & ACCURACY CHECK...")

    metrics          = validate_transactions(code_txns, llm_txns)
    comparison_score = metrics.get("overall_accuracy", 0) if metrics else 0

    code_confidence = round(
        sum(t.get("confidence", 0) for t in code_txns) / len(code_txns), 2
    ) if code_txns else 0

    llm_confidence = round(
        sum(t.get("confidence", 0) for t in llm_txns) / len(llm_txns), 2
    ) if llm_txns else 0

    code_passes_quality = validate_extraction_propriety(code_txns)

    has_code = len(code_txns) > 0
    has_llm  = len(llm_txns) > 0

    logger.info("Code accuracy    : %.2f%%", comparison_score)
    logger.info("Code confidence  : %.2f",   code_confidence)
    logger.info("LLM confidence   : %.2f",   llm_confidence)
    logger.info("Code propriety   : %s",      "PASS" if code_passes_quality else "FAIL")
    logger.info("Has CODE txns    : %s",      has_code)
    logger.info("Has LLM txns     : %s",      has_llm)

    # ── Decision ──────────────────────────────────────────────────────────────
    # Never demote an already-ACTIVE format — it has been vetted and promoted.
    keep_active = (statement_status == "ACTIVE")

    if has_code and not has_llm:
        final_parser_type    = "CODE"
        new_statement_status = "ACTIVE" if keep_active else "EXPERIMENTAL"
        logger.info("DECISION: CODE WINS — LLM returned 0 transactions")
        logger.info("Format status → %s", new_statement_status)

    elif has_llm and not has_code:
        final_parser_type    = "LLM"
        new_statement_status = "ACTIVE" if keep_active else "EXPERIMENTAL"
        logger.info("DECISION: LLM WINS — CODE returned 0 transactions")
        logger.info("Format status → %s", new_statement_status)

    elif (comparison_score >= 90 and code_passes_quality and len(code_txns) == len(llm_txns)) or (comparison_score == 100 and has_code and len(code_txns) == len(llm_txns)):
        final_parser_type    = "CODE"
        new_statement_status = "ACTIVE"
        logger.info(
            "DECISION: CODE WINS (Perfect match with LLM or High accuracy + Quality) → ACTIVE"
        )

    elif not has_code and not has_llm:
        final_parser_type    = "LLM"
        new_statement_status = "ACTIVE" if keep_active else "EXPERIMENTAL"
        logger.warning("DECISION: BOTH empty — defaulting to LLM (nothing)")

    else:
        final_parser_type    = "LLM"
        new_statement_status = "ACTIVE" if keep_active else "EXPERIMENTAL"
        reason = f"code accuracy {comparison_score:.2f}% < 90% or propriety check failed"
        logger.info("DECISION: LLM WINS (%s)", reason)
        logger.info("Format status → %s", new_statement_status)

    # ── Persist ───────────────────────────────────────────────────────────────
    if statement_id:
        update_statement_status(statement_id, new_statement_status)
        update_success_rate(statement_id, comparison_score)

    update_processing_complete(document_id, final_parser_type)
    insert_staging_transactions(
        document_id     = document_id,
        user_id         = user_id,
        code_txns       = code_txns,
        llm_txns        = llm_txns,
        code_confidence = code_confidence,
        llm_confidence  = llm_confidence,
    )
    update_document_status(document_id, "AWAITING_REVIEW")
    insert_audit(document_id, "COMPLETED")

    logger.info("")
    logger.info("PIPELINE COMPLETE for document_id=%s", document_id)
    logger.info("Winner       : %s", final_parser_type)
    logger.info("CODE txns    : %d", len(code_txns))
    logger.info("LLM txns     : %d", len(llm_txns))
    logger.info("Accuracy     : %.2f%%", comparison_score)
    logger.info("New status   : %s", new_statement_status)
    logger.info("═" * 70)