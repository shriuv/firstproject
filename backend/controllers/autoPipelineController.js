/**
 * autoPipelineController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Internal endpoint: POST /internal/auto-pipeline
 *
 * Called by the Python merchant_grouping job (via HTTP) after grouping
 * completes for a document. Not user-facing — protected by a shared secret.
 *
 * Runs Stages 1–3 of the categorisation pipeline:
 *   Stage 1   — FAST_PATH (rules engine)
 *   Stage 1.5 — EXACT_THEN_DUMP (P_EXACT personal exact cache)
 *   Stage 3   — Vector similarity (P_VEC → G_KEY → G_VEC)
 *
 * LLM leftovers are written to llm_queue for pickup when the user clicks
 * "LLM Categorise".
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const logger = require('../utils/logger');
const supabase = require('../config/supabaseClient');
const rulesEngineService = require('../services/rulesEngineService');
const personalCacheService = require('../services/personalCacheService');
const vectorMatchService = require('../services/vectorMatchService');

// ── Person-name heuristic ───────────────────────────────────────────────────
function isPotentialPerson(cleanName) {
  if (!cleanName) return false;
  const s = cleanName.trim().toUpperCase();
  const words = s.split(/\s+/);
  return /^[A-Z\s]{4,40}$/.test(s) && words.length >= 1 && words.length <= 4;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function verifyInternalSecret(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const secret = process.env.INTERNAL_SECRET || '';
  return secret && token === secret;
}

// ── Account-id helper ────────────────────────────────────────────────────────
async function getAccountIdFromTemplate(templateId, userId) {
  if (!templateId) return null;

  const { data: existing } = await supabase
    .from('accounts')
    .select('account_id')
    .eq('user_id', userId)
    .eq('template_id', templateId)
    .eq('is_active', true)
    .limit(1);

  if (existing && existing.length > 0) return existing[0].account_id;

  const { data: tData } = await supabase.from('templates').select('template_name').eq('id', templateId).single();
  const fallbackNames = {
    14: 'Healthcare & Medical', 30: 'Education & Books', 35: 'Housing & Rent', 36: 'Food & Dining',
    37: 'Travel & Transport', 38: 'Shopping & Clothing', 39: 'Mobile & Utilities', 40: 'Mobile & Utilities',
    41: 'Insurance', 43: 'Investment & Savings', 45: 'Entertainment & Leisure', 52: 'Gifts & Donations',
    97: 'Personal Care', 116: 'Subscriptions & Memberships', 121: 'Bank Charges & Fees', 213: 'Groceries',
    227: 'Travel & Transport', 303: 'Other Taxes & Levies', 310: 'Fuel', 325: 'Miscellaneous',
    433: 'ATM & Cash Withdrawal', 541: 'Investment & Savings', 549: 'Loan & EMI', 550: 'Credit Card Payment',
    578: 'Stationery & Office Supplies'
  };

  const accountName = (tData && tData.template_name) ? tData.template_name : fallbackNames[templateId];
  if (!accountName) return null;

  const { data: newAcc, error: createError } = await supabase
    .from('accounts')
    .insert({
      user_id: userId,
      account_name: accountName,
      template_id: templateId,
      account_type: 'EXPENSE',
      is_active: true,
      balance_nature: 'DEBIT'
    })
    .select('account_id')
    .single();

  return createError ? null : newAcc.account_id;
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function runAutoPipeline(req, res) {
  if (!verifyInternalSecret(req)) {
    logger.warn('[AUTO-PIPELINE] Rejected — bad or missing INTERNAL_SECRET');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { document_id, user_id } = req.body || {};
  if (!document_id || !user_id) return res.status(400).json({ error: 'document_id and user_id are required' });

  logger.info('[AUTO-PIPELINE] START', { document_id, user_id });

  await supabase.from('documents').update({
    grouping_status: 'pipeline_running',
    pipeline_started_at: new Date().toISOString(),
    pipeline_error: null,
  }).eq('document_id', document_id);

  let pipelineError = null;
  try {
    // 1. Fetch pending transactions
    const { data: existingTxns } = await supabase.from('transactions').select('uncategorized_transaction_id').eq('document_id', document_id);
    const existingIds = (existingTxns || []).map(r => r.uncategorized_transaction_id);

    let uncatQuery = supabase.from('uncategorized_transactions').select('*').eq('document_id', document_id).eq('user_id', user_id);
    if (existingIds.length > 0) uncatQuery = uncatQuery.not('uncategorized_transaction_id', 'in', `(${existingIds.join(',')})`);
    
    const { data: uncatRows } = await uncatQuery.in('grouping_status', ['done', 'pipeline_running']);
    const pending = uncatRows || [];
    if (pending.length === 0) return res.json({ resolved: 0, llm_pending: 0, document_id });

    // 2. Pre-computed Map
    const preComputedMap = new Map();
    const groupRepMap = new Map();
    for (const row of pending) {
      preComputedMap.set(row.uncategorized_transaction_id, row);
      if (row.group_id && (!groupRepMap.has(row.group_id) || row.uncategorized_transaction_id < groupRepMap.get(row.group_id))) {
        groupRepMap.set(row.group_id, row.uncategorized_transaction_id);
      }
    }

    const groupResultMap = new Map(); 
    const resolvedRows = [];          
    const llmLeftovers = [];          

    // 3. STAGE 1 & 1.5: Fast Path and Personal Exact
    const representatives = pending.filter(txn => !txn.group_id || groupRepMap.get(txn.group_id) === txn.uncategorized_transaction_id);
    const vectorNeeded = [];

    for (const txn of representatives) {
      const strategy = txn.pre_pipeline_strategy;
      if (strategy === 'FAST_PATH') {
        const rulesResult = rulesEngineService.evaluateTransaction(txn.details);
        const categoryAccountId = await getAccountIdFromTemplate(rulesResult.targetTemplateId, user_id);
        if (categoryAccountId) {
          const result = { offset_account_id: categoryAccountId, categorised_by: 'G_RULE', confidence_score: 1.0, attention_level: 'LOW' };
          if (txn.group_id) groupResultMap.set(txn.group_id, result);
          resolvedRows.push({ txn, result });
          continue;
        }
      }

      if (strategy === 'EXACT_THEN_DUMP') {
        const rulesResult = rulesEngineService.evaluateTransaction(txn.details);
        const searchKey = rulesResult.extractedId || txn.details;
        const personalMatch = await personalCacheService.checkExactMatch(user_id, searchKey);
        if (personalMatch) {
          const result = { offset_account_id: personalMatch.offset_account_id, categorised_by: 'P_EXACT', confidence_score: 1.0, attention_level: 'LOW' };
          if (txn.group_id) groupResultMap.set(txn.group_id, result);
          resolvedRows.push({ txn, result });
          continue;
        }
      }
      vectorNeeded.push(txn);
    }

    // 4. STAGE 3: Batched Vector/Keyword Matching (Parallel)
    const BATCH_SIZE = 3;
    for (let i = 0; i < vectorNeeded.length; i += BATCH_SIZE) {
      const batch = vectorNeeded.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (txn) => {
        const transactionType = txn.debit ? 'DEBIT' : 'CREDIT';
        const stringToMatch = txn.details || txn.clean_merchant_name;
        if (stringToMatch) {
          try {
            const vectorMatch = await vectorMatchService.findVectorMatch(stringToMatch, user_id, transactionType);
            if (vectorMatch) {
              const result = { offset_account_id: vectorMatch.offset_account_id, categorised_by: vectorMatch.categorised_by, confidence_score: vectorMatch.confidence_score, attention_level: (vectorMatch.confidence_score < 0.7) ? 'MEDIUM' : 'LOW' };
              if (txn.group_id) groupResultMap.set(txn.group_id, result);
              resolvedRows.push({ txn, result });
              return;
            }
          } catch (err) { logger.error('[AUTO-PIPELINE] Vector match failed', { txnId: txn.uncategorized_transaction_id, error: err.message }); }
        }
        if (txn.group_id) groupResultMap.set(txn.group_id, null);
        llmLeftovers.push(txn.uncategorized_transaction_id);
      }));
    }

    // 5. Fan-out and Batch Insert
    for (const txn of pending) {
      if (txn.group_id && groupRepMap.get(txn.group_id) !== txn.uncategorized_transaction_id) {
        const res = groupResultMap.get(txn.group_id);
        if (res) resolvedRows.push({ txn, result: res });
        else if (res === null) llmLeftovers.push(txn.uncategorized_transaction_id);
      }
    }

    if (resolvedRows.length > 0) {
      const insertRows = resolvedRows.map(({ txn, result }) => ({
        user_id, document_id, transaction_date: txn.txn_date, details: txn.details,
        amount: txn.debit || txn.credit || 0, transaction_type: txn.debit ? 'DEBIT' : 'CREDIT',
        offset_account_id: result.offset_account_id, categorised_by: result.categorised_by,
        confidence_score: result.confidence_score, attention_level: result.attention_level,
        uncategorized_transaction_id: txn.uncategorized_transaction_id, review_status: 'PENDING'
      }));
      
      const { error: insertErr } = await supabase.from('transactions').insert(insertRows);
      
      if (!insertErr) {
        // Mark as categorized in the source table so they disappear from the "Pending" UI
        const ids = resolvedRows.map(r => r.txn.uncategorized_transaction_id);
        await supabase
          .from('uncategorized_transactions')
          .update({ grouping_status: 'categorized' })
          .in('uncategorized_transaction_id', ids);
        
        logger.info('[AUTO-PIPELINE] Batch insert OK and source table updated', { count: ids.length });
      } else {
        logger.error('[AUTO-PIPELINE] Batch insert failed', { error: insertErr.message });
      }
    }

    if (llmLeftovers.length > 0) {
      const queueRows = llmLeftovers.map(id => ({ uncategorized_transaction_id: id, user_id, document_id, status: 'pending' }));
      await supabase.from('llm_queue').insert(queueRows);
    }

    res.json({ resolved: resolvedRows.length, llm_pending: llmLeftovers.length, document_id });

  } catch (err) {
    pipelineError = err;
    logger.error('[AUTO-PIPELINE] Unhandled exception', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    const status = pipelineError ? 'pipeline_failed' : 'pipeline_done';
    await supabase.from('documents').update({ grouping_status: status, pipeline_error: pipelineError?.message }).eq('document_id', document_id);
  }
}

module.exports = { runAutoPipeline };
