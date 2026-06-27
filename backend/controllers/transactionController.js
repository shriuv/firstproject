const supabase = require('../config/supabaseClient');
const { upsertExactCache, upsertVectorCache, isGarbage } = require('../services/personalCacheService');
const rulesEngineService = require('../services/rulesEngineService');

/**
 * Helper to build ledger entries for an approved transaction.
 * Returns an array of objects to be inserted into 'journal_entries'.
 */
function buildLedgerRows(txn, userId) {
  const { transaction_id, base_account_id, offset_account_id, amount, transaction_type, transaction_date, is_contra } = txn;

  // For a contra, skip the mirror INCOME leg
  if (is_contra && transaction_type === 'INCOME') {
    return [];
  }

  if (!transaction_id || !base_account_id || !offset_account_id || !amount) {
    console.warn(`⚠️ Missing required fields for txn ${transaction_id}`);
    return [];
  }

  const entries = transaction_type === 'EXPENSE'
    ? [
        { account_id: offset_account_id, debit_amount: amount,  credit_amount: 0 },
        { account_id: base_account_id,   debit_amount: 0,        credit_amount: amount }
      ]
    : [
        { account_id: base_account_id,   debit_amount: amount,  credit_amount: 0 },
        { account_id: offset_account_id, debit_amount: 0,        credit_amount: amount }
      ];

  return entries.map(e => ({
    transaction_id,
    account_id: e.account_id,
    debit_amount: e.debit_amount,
    credit_amount: e.credit_amount,
    entry_date: transaction_date,
    user_id: userId
  }));
}

/**
 * Creates double-entry ledger entries for an approved transaction.
 * Every transaction produces exactly 2 ledger entries.
 * 
 * For a DEBIT (money out from base account):
 *   - DEBIT  the offset account (expense goes up)
 *   - CREDIT the base account   (asset goes down)
 *
 * For a CREDIT (money in to base account):
 *   - DEBIT  the base account   (asset goes up)
 *   - CREDIT the offset account (income goes up)
 */
async function createLedgerEntries(transactionId, baseAccountId, offsetAccountId, amount, transactionType, transactionDate, isContra, userId) {
  const rows = buildLedgerRows({
    transaction_id: transactionId,
    base_account_id: baseAccountId,
    offset_account_id: offsetAccountId,
    amount,
    transaction_type: transactionType,
    transaction_date: transactionDate,
    is_contra: isContra
  }, userId);

  if (rows.length === 0) return;

  const { error } = await supabase.from('journal_entries').insert(rows);
  if (error) {
    if (error.code === '23505') {
      // Unique constraint violation — already processed, safe to ignore
      console.warn(`⚠️ Duplicate skipped for txn ${transactionId}: ledger entries already created`);
      return;
    }
    console.error(`❌ Failed to create ledger entries for txn ${transactionId}:`, error);
  } else {
    console.log(`✅ Ledger entries created for txn ${transactionId}`);
  }
}

/**
 * recategorizeTransaction(req, res)
 * Updates a transaction with a new offset_account_id and marks as MANUAL.
 * Resets review_status to PENDING since the category changed.
 * Enforces user ownership.
 */
async function recategorizeTransaction(req, res) {
  try {
    const transactionId = req.params.id;
    const { offset_account_id } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }

    if (!transactionId || offset_account_id === undefined || offset_account_id === null) {
      return res.status(400).json({ error: 'Missing transactionId or offset_account_id.' });
    }

    // Check if the new account is uncategorised
    const { data: newAccount } = await supabase
      .from('accounts')
      .select('account_name')
      .eq('account_id', offset_account_id)
      .single();

    const isUncategorised = newAccount?.account_name === 'Uncategorised Expense' ||
                           newAccount?.account_name === 'Uncategorised Income';

    // Update with user_id constraint to ensure ownership
    const { error } = await supabase
      .from('transactions')
      .update({
        offset_account_id: offset_account_id,
        categorised_by: 'MANUAL',
        review_status: 'PENDING',
        is_uncategorised: isUncategorised
      })
      .eq('transaction_id', transactionId)
      .eq('user_id', userId);

    if (error) {
      console.error('Recategorize transaction error:', error);
      return res.status(500).json({ error: 'Failed to recategorize transaction.' });
    }

    // Fetch the just-updated transaction to get match fields (include details for rules engine fallback).
    // Fix A: pull group_id via FK join in the same round-trip — no separate uncategorized_transactions fetch.
    const { data: updatedTxn } = await supabase
      .from('transactions')
      .select('extracted_id, transaction_type, offset_account_id, details, uncategorized_transaction_id, uncat_row:uncategorized_transaction_id ( group_id )')
      .eq('transaction_id', transactionId)
      .eq('user_id', userId)
      .single();

    let similarTransactions = [];
    let suggestedAccount = null;

    if (updatedTxn) {
      const { transaction_type, offset_account_id, details } = updatedTxn;

      // If extracted_id wasn't stored (e.g. was dumped before bulkController fix),
      // re-run the rules engine on `details` to recover the merchant key.
      let extracted_id = updatedTxn.extracted_id;
      if (!extracted_id && details) {
        const rulesResult = rulesEngineService.evaluateTransaction(details);
        if (rulesResult.hasRuleMatch && rulesResult.extractedId) {
          extracted_id = rulesResult.extractedId;
        }
      }

      // Fetch account name for suggestedAccount
      const { data: suggestedAccountData } = await supabase
        .from('accounts')
        .select('account_id, account_name')
        .eq('account_id', offset_account_id)
        .single();

      suggestedAccount = suggestedAccountData || null;

      // ── Priority 0: group_id matching ──────────────────────────────────────
      // Surface group members that are not yet APPROVED.
      // Two buckets:
      //   a) Already in transactions as PENDING — shown as regular similar txns
      //   b) Not yet in transactions at all (pre-pipeline) — shown as is_pre_pipeline
      //
      // Fix A: group_id is already available via the uncat_row FK join above.
      const groupId = updatedTxn.uncat_row?.group_id;
      const currentUncatId = updatedTxn.uncategorized_transaction_id;

      if (groupId && currentUncatId) {
        // Priority 0a: Fetch sibling uncategorized_transaction_ids for this group from the
        // source table first, then use .in() on transactions — this guarantees correct DB-side
        // filtering without relying on the broken PostgREST join-filter syntax.
        const { data: siblingUncatRows } = await supabase
          .from('uncategorized_transactions')
          .select('uncategorized_transaction_id')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .neq('uncategorized_transaction_id', currentUncatId)
          .neq('grouping_status', 'skipped');

        const siblingUncatIds = (siblingUncatRows || []).map(r => r.uncategorized_transaction_id);

        if (siblingUncatIds.length > 0) {
          const { data: pendingGroupTxns } = await supabase
            .from('transactions')
            .select(`
              transaction_id,
              uncategorized_transaction_id,
              amount,
              transaction_type,
              transaction_date,
              details,
              extracted_id,
              offset_account_id,
              attention_level,
              current_account:offset_account_id ( account_id, account_name )
            `)
            .eq('user_id', userId)
            .eq('review_status', 'PENDING')
            .in('uncategorized_transaction_id', siblingUncatIds)
            .limit(20);

          if (pendingGroupTxns && pendingGroupTxns.length > 0) {
            similarTransactions = pendingGroupTxns;
          }
        }

        // b) Pre-pipeline members: uncategorized rows in the group with no transactions row yet.
        if (similarTransactions.length === 0 && siblingUncatIds.length > 0) {
          const { data: prePipelineRaw } = await supabase
            .from('uncategorized_transactions')
            .select(`
              uncategorized_transaction_id, details, txn_date, debit, credit, account_id,
              txn_check:transactions ( uncategorized_transaction_id )
            `)
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .neq('uncategorized_transaction_id', currentUncatId)
            .neq('grouping_status', 'skipped')
            .is('txn_check', null)
            .limit(20);

          if (prePipelineRaw && prePipelineRaw.length > 0) {
            similarTransactions = prePipelineRaw.map(m => ({
              transaction_id: null,
              amount: m.debit || m.credit,
              transaction_type: m.debit ? 'EXPENSE' : 'INCOME',
              transaction_date: m.txn_date,
              details: m.details,
              offset_account_id: null,
              attention_level: 'HIGH',
              current_account: null,
              uncategorized_transaction_id: m.uncategorized_transaction_id,
              is_pre_pipeline: true
            }));
          }
        }
      }

      // If Priority 0 found results, skip Priority 1 and Priority 2
      if (similarTransactions.length === 0) {
        // Build match condition
        let similarQuery = supabase
          .from('transactions')
          .select(`
            transaction_id,
            uncategorized_transaction_id,
            amount,
            transaction_type,
            transaction_date,
            details,
            extracted_id,
            offset_account_id,
            attention_level,
            current_account:offset_account_id (
              account_id,
              account_name
            )
          `)
          .eq('user_id', userId)
          .eq('transaction_type', transaction_type)
          .neq('transaction_id', transactionId);

        // Priority 1: match on extracted_id — includes approved history so the user
        //             can see past categorisation decisions as a reference.
        // Priority 2: fallback to same offset_account_id, HIGH/MEDIUM attention only,
        //             limited to categorised rows (more conservative since less precise).
        if (extracted_id) {
          similarQuery = similarQuery
            .eq('extracted_id', extracted_id)
            .order('transaction_date', { ascending: false });
        } else {
          similarQuery = similarQuery
            .eq('review_status', 'PENDING')
            .eq('offset_account_id', offset_account_id)
            .eq('is_uncategorised', false)
            .in('attention_level', ['HIGH', 'MEDIUM']);
        }

        const { data: similar } = await similarQuery.limit(20);
        similarTransactions = similar || [];
      }
      // ── End similar transaction logic ─────────────────────────────────────
    }

    return res.status(200).json({
      success: true,
      similarTransactions,
      suggestedAccount
    });
  } catch (err) {
    console.error('Unexpected error in recategorizeTransaction:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * approveTransaction(req, res)
 * Updates a transaction to mark as approved and posted.
 * Sets review_status to APPROVED and posting_status to POSTED.
 * Enforces user ownership.
 */
async function approveTransaction(req, res) {
  const label = `approve:${req.params.id}`;
  console.log(`\n\n=== APPROVE ROUTE HIT FOR TXN ${req.params.id} ===\n\n`);
  console.time(label);
  try {
    const transactionId = req.params.id;
    const userId = req.user?.id;

    if (!userId) {
      console.timeEnd(label);
      return res.status(401).json({ error: 'User authentication failed.' });
    }

    if (!transactionId) {
      console.timeEnd(label);
      return res.status(400).json({ error: 'Missing transactionId.' });
    }

    // Fetch full transaction row (needed for both the uncategorised guard and similar-txn lookup)
    // Also join uncategorized_transactions to pull group_id for Priority 0 matching.
    console.time(`${label}:1-fetch-txn`);
    const { data: txnCheck } = await supabase
      .from('transactions')
      .select('extracted_id, transaction_type, offset_account_id, details, uncategorized_transaction_id, accounts!transactions_offset_account_id_fkey(account_name), uncat_row:uncategorized_transaction_id ( group_id )')
      .eq('transaction_id', transactionId)
      .eq('user_id', userId)
      .single();
    console.timeEnd(`${label}:1-fetch-txn`);

    if (txnCheck?.accounts?.account_name === 'Uncategorised Expense' ||
        txnCheck?.accounts?.account_name === 'Uncategorised Income') {
      console.timeEnd(label);
      return res.status(400).json({
        error: 'Cannot approve: transaction uses uncategorised account. Please assign a category first.'
      });
    }

    // Update with user_id constraint to ensure ownership
    console.time(`${label}:2-status-update`);
    const { error } = await supabase
      .from('transactions')
      .update({
        review_status: 'APPROVED',
        posting_status: 'POSTED'
      })
      .eq('transaction_id', transactionId)
      .eq('user_id', userId);
    console.timeEnd(`${label}:2-status-update`);

    if (error) {
      if (error.code === '23505') {
        console.warn(`⚠️ Duplicate skipped for txn ${transactionId}: already approved`);
        console.timeEnd(label);
        return res.status(200).json({ success: true, note: 'already_approved', similarTransactions: [], suggestedAccount: null });
      }
      console.error('Approve transaction error:', error);
      console.timeEnd(label);
      return res.status(500).json({ error: 'Failed to approve transaction.' });
    }

    // ── Similar transaction lookup ─────────────────────────────────────────
    // Find other PENDING transactions with the same merchant/category so the
    // user can batch-approve them via the "Similar Transactions Found" popup.
    let similarTransactions = [];
    let suggestedAccount = null;

    if (txnCheck) {
      const { transaction_type, offset_account_id, details } = txnCheck;

      // Try to recover extracted_id via rules engine if not stored
      let extracted_id = txnCheck.extracted_id;
      if (!extracted_id && details) {
        const rulesResult = rulesEngineService.evaluateTransaction(details);
        if (rulesResult.hasRuleMatch && rulesResult.extractedId) {
          extracted_id = rulesResult.extractedId;
        }
      }

      // Fetch the offset account name for the popup header
      console.time(`${label}:3-fetch-account`);
      const { data: suggestedAccountData } = await supabase
        .from('accounts')
        .select('account_id, account_name')
        .eq('account_id', offset_account_id)
        .single();
      suggestedAccount = suggestedAccountData || null;
      console.timeEnd(`${label}:3-fetch-account`);

      // ── Priority 0: group_id matching ──────────────────────────────────────
      // Surface group members that are not yet APPROVED.
      // Two buckets:
      //   a) Already in transactions as PENDING — shown as regular similar txns
      //   b) Not yet in transactions at all (pre-pipeline) — shown as is_pre_pipeline
      //
      // group_id is available via the uncat_row FK join on txnCheck.
      const groupId = txnCheck.uncat_row?.group_id;
      const currentUncatId = txnCheck.uncategorized_transaction_id;

      if (groupId && currentUncatId) {
        // Priority 0a: Fetch sibling uncategorized_transaction_ids for this group from the
        // source table first, then use .in() on transactions — this guarantees correct DB-side
        // filtering without relying on the broken PostgREST join-filter syntax.
        console.time(`${label}:4a-group-sibling-uncat`);
        const { data: siblingUncatRows } = await supabase
          .from('uncategorized_transactions')
          .select('uncategorized_transaction_id')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .neq('uncategorized_transaction_id', currentUncatId)
          .neq('grouping_status', 'skipped');
        console.timeEnd(`${label}:4a-group-sibling-uncat`);

        const siblingUncatIds = (siblingUncatRows || []).map(r => r.uncategorized_transaction_id);

        if (siblingUncatIds.length > 0) {
          console.time(`${label}:4b-group-pending-txns`);
          const { data: pendingGroupTxns } = await supabase
            .from('transactions')
            .select(`
              transaction_id,
              uncategorized_transaction_id,
              amount,
              transaction_type,
              transaction_date,
              details,
              extracted_id,
              offset_account_id,
              attention_level,
              current_account:offset_account_id ( account_id, account_name )
            `)
            .eq('user_id', userId)
            .eq('review_status', 'PENDING')
            .in('uncategorized_transaction_id', siblingUncatIds)
            .limit(20);
          console.timeEnd(`${label}:4b-group-pending-txns`);

          if (pendingGroupTxns && pendingGroupTxns.length > 0) {
            similarTransactions = pendingGroupTxns;
          }
        }

        // b) Pre-pipeline members: uncategorized rows in the group with no transactions row yet.
        if (similarTransactions.length === 0 && siblingUncatIds && siblingUncatIds.length > 0) {
          console.time(`${label}:4c-group-pre-pipeline`);
          const { data: prePipelineRaw } = await supabase
            .from('uncategorized_transactions')
            .select(`
              uncategorized_transaction_id, details, txn_date, debit, credit, account_id,
              txn_check:transactions ( uncategorized_transaction_id )
            `)
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .neq('uncategorized_transaction_id', currentUncatId)
            .neq('grouping_status', 'skipped')
            .is('txn_check', null)
            .limit(20);
          console.timeEnd(`${label}:4c-group-pre-pipeline`);

          if (prePipelineRaw && prePipelineRaw.length > 0) {
            similarTransactions = prePipelineRaw.map(m => ({
              transaction_id: null,
              amount: m.debit || m.credit,
              transaction_type: m.debit ? 'EXPENSE' : 'INCOME',
              transaction_date: m.txn_date,
              details: m.details,
              offset_account_id: null,
              attention_level: 'HIGH',
              current_account: null,
              uncategorized_transaction_id: m.uncategorized_transaction_id,
              is_pre_pipeline: true
            }));
          }
        }
      }

      // If Priority 0 found results, skip Priority 1 and Priority 2
      if (similarTransactions.length === 0) {
        // Priority 1: match on extracted_id — includes approved history so the user
        //             can see past categorisation decisions as a reference.
        // Priority 2: same offset_account_id, HIGH/MEDIUM attention (broader fallback, PENDING only).
        let similarQuery = supabase
          .from('transactions')
          .select(`
            transaction_id,
            uncategorized_transaction_id,
            amount,
            transaction_type,
            transaction_date,
            details,
            extracted_id,
            offset_account_id,
            attention_level,
            current_account:offset_account_id (
              account_id,
              account_name
            )
          `)
          .eq('user_id', userId)
          .eq('transaction_type', transaction_type)
          .neq('transaction_id', transactionId);

        const stratLabel = extracted_id ? 'priority1-extracted-id' : 'priority2-offset-account';
        console.time(`${label}:5-similar-${stratLabel}`);
        if (extracted_id) {
          similarQuery = similarQuery
            .eq('extracted_id', extracted_id)
            .order('transaction_date', { ascending: false });
        } else {
          similarQuery = similarQuery
            .eq('review_status', 'PENDING')
            .eq('offset_account_id', offset_account_id)
            .eq('is_uncategorised', false)
            .in('attention_level', ['HIGH', 'MEDIUM']);
        }

        const { data: similar } = await similarQuery.limit(20);
        console.timeEnd(`${label}:5-similar-${stratLabel}`);
        similarTransactions = similar || [];
      }
    }
    // ── End similar transaction lookup ────────────────────────────────────

    console.timeEnd(label);
    // Phase 1 Response — includes similar txns so frontend can show popup
    res.status(200).json({ success: true, similarTransactions, suggestedAccount });

    // Phase 2: Background processing (Ledger entries + Caching)
    setImmediate(async () => {
      const bgLabel = `approve-bg:${transactionId}`;
      console.time(bgLabel);
      try {
        console.time(`${bgLabel}:fetch-txn`);
        const { data: txnData } = await supabase
          .from('transactions')
          .select('transaction_id, base_account_id, offset_account_id, amount, transaction_type, transaction_date, is_contra, details, clean_merchant_name, extracted_id')
          .eq('transaction_id', transactionId)
          .eq('user_id', userId)
          .single();
        console.timeEnd(`${bgLabel}:fetch-txn`);

        if (txnData) {
          console.time(`${bgLabel}:ledger-entries`);
          await createLedgerEntries(
            txnData.transaction_id,
            txnData.base_account_id,
            txnData.offset_account_id,
            txnData.amount,
            txnData.transaction_type,
            txnData.transaction_date,
            txnData.is_contra || false,
            userId
          );
          console.timeEnd(`${bgLabel}:ledger-entries`);

          if (!txnData.is_contra) {
            const cacheLabel = txnData.extracted_id ? 'exact-cache' : 'vector-cache';
            console.time(`${bgLabel}:${cacheLabel}`);
            if (txnData.extracted_id) {
              await upsertExactCache(userId, txnData.extracted_id, txnData.offset_account_id);
            } else {
              const nameToCache = txnData.clean_merchant_name || txnData.details;
              await upsertVectorCache(userId, nameToCache, txnData.offset_account_id);
            }
            console.timeEnd(`${bgLabel}:${cacheLabel}`);
          }
        }
        console.timeEnd(bgLabel);
      } catch (bgError) {
        console.error(`❌ Background processing failed for txn ${transactionId}:`, bgError);
        console.timeEnd(bgLabel);
      }
    });

  } catch (err) {
    console.error('Unexpected error in approveTransaction:', err);
    console.timeEnd(label);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * bulkApproveTransactions(req, res)

 * Updates multiple transactions to mark as approved and posted.
 * Expects req.body.transaction_ids = array of transaction_ids
 * Enforces user ownership.
 */
async function bulkApproveTransactions(req, res) {
  try {
    const { transaction_ids } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      return res.status(400).json({ error: 'transaction_ids must be a non-empty array.' });
    }

    // Check if any transaction uses uncategorised fallback account
    const { data: uncategorisedCheck } = await supabase
      .from('transactions')
      .select('transaction_id, accounts!transactions_offset_account_id_fkey(account_name)')
      .in('transaction_id', transaction_ids)
      .eq('user_id', userId);

    const blockedIds = uncategorisedCheck?.filter(txn =>
      txn.accounts?.account_name === 'Uncategorised Expense' ||
      txn.accounts?.account_name === 'Uncategorised Income'
    ).map(txn => txn.transaction_id) || [];

    // Filter out blocked IDs from the approval list
    const approvableIds = transaction_ids.filter(id => !blockedIds.includes(id));

    if (approvableIds.length === 0) {
      return res.status(400).json({
        error: 'Cannot approve: all transactions use uncategorised accounts.',
        blocked_transaction_ids: blockedIds,
        approved_count: 0
      });
    }

    // Update only approvable transactions
    const { error, data } = await supabase
      .from('transactions')
      .update({
        review_status: 'APPROVED',
        posting_status: 'POSTED'
      })
      .in('transaction_id', approvableIds)
      .eq('user_id', userId)
      .select('transaction_id');

    if (error) {
      if (error.code === '23505') {
        // Unique constraint violation — already processed, safe to ignore
        console.warn(`⚠️ Duplicate skipped for bulk txns: already approved`);
        return res.status(200).json({ success: true, note: 'already_approved' });
      }
      console.error('Bulk approve transactions error:', error);
      return res.status(500).json({ error: 'Failed to approve transactions.' });
    }

    const approvedCount = data ? data.length : 0;
    const blockedCount = blockedIds.length;

    // Phase 1 Response — respond immediately after update succeeds
    if (blockedCount > 0) {
      res.status(200).json({
        success: true,
        approved_count: approvedCount,
        blocked_count: blockedCount,
        blocked_transaction_ids: blockedIds,
        message: `${approvedCount} transactions approved. ${blockedCount} transactions require categorisation.`
      });
    } else {
      res.status(200).json({ success: true, approved_count: approvedCount });
    }

    // Phase 2: Background processing
    const approvedIds = data ? data.map(t => t.transaction_id) : [];
    if (approvedIds.length > 0) {
      setImmediate(async () => {
        try {
          const { data: txnRows } = await supabase
            .from('transactions')
            .select('transaction_id, base_account_id, offset_account_id, amount, transaction_type, transaction_date, details, clean_merchant_name, is_contra, extracted_id')
            .in('transaction_id', approvedIds)
            .eq('user_id', userId);

          if (!txnRows || txnRows.length === 0) return;

          // Build ALL ledger entries rows in one pass
          const allLedgerRows = [];
          for (const txn of txnRows) {
            const entries = buildLedgerRows(txn, userId);
            allLedgerRows.push(...entries);
          }

          // Insert ALL ledger rows in a single supabase call
          if (allLedgerRows.length > 0) {
            const { error: ledgerError } = await supabase.from('journal_entries').insert(allLedgerRows);
            if (ledgerError) console.error('Background bulk ledger insert failed:', ledgerError);
          }

          // Run all cache upserts in parallel
          await Promise.all(txnRows.map(txn => {
            if (txn.is_contra) return Promise.resolve();
            if (txn.extracted_id) {
              return upsertExactCache(userId, txn.extracted_id, txn.offset_account_id);
            }
            const name = txn.clean_merchant_name || txn.details;
            return upsertVectorCache(userId, name, txn.offset_account_id);
          }));

          console.log(`✅ Background bulk approval complete for ${txnRows.length} transactions`);
        } catch (bgError) {
          console.error('❌ Background bulk approve processing failed:', bgError);
        }
      });
    }
  } catch (err) {
    console.error('Unexpected error in bulkApproveTransactions:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * bulkAssignAndApproveTransactions(req, res)
 * Updates multiple transactions (or creates them if missing) with a new offset_account_id,
 * sets categorised_by to MANUAL, and marks them as approved and posted.
 * Expects req.body.uncategorized_transaction_ids = array of ids and req.body.offset_account_id
 */
async function bulkAssignAndApproveTransactions(req, res) {
  try {
    const { uncategorized_transaction_ids, offset_account_id } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'User authentication failed.' });
    if (!Array.isArray(uncategorized_transaction_ids) || uncategorized_transaction_ids.length === 0) {
      return res.status(400).json({ error: 'uncategorized_transaction_ids must be a non-empty array.' });
    }
    if (!offset_account_id) return res.status(400).json({ error: 'Missing offset_account_id.' });

    const { data: newAccount } = await supabase
      .from('accounts')
      .select('account_name')
      .eq('account_id', offset_account_id)
      .single();

    if (newAccount?.account_name === 'Uncategorised Expense' || newAccount?.account_name === 'Uncategorised Income') {
      return res.status(400).json({ error: 'Cannot assign to an uncategorised account.' });
    }

    // Step 1: Update existing transactions
    const { data: updatedTxns, error: updateError } = await supabase
      .from('transactions')
      .update({
        offset_account_id,
        categorised_by: 'MANUAL',
        is_uncategorised: false,
        review_status: 'APPROVED',
        posting_status: 'POSTED'
      })
      .in('uncategorized_transaction_id', uncategorized_transaction_ids)
      .eq('user_id', userId)
      .select('transaction_id, uncategorized_transaction_id');

    if (updateError) {
      console.error('Bulk update error in assign/approve:', updateError);
      return res.status(500).json({ error: 'Failed to assign and approve transactions.' });
    }

    const updatedUncatIds = new Set((updatedTxns || []).map(t => t.uncategorized_transaction_id));
    const uncatIdsToCreate = uncategorized_transaction_ids.filter(id => !updatedUncatIds.has(id));

    // Step 2: Insert missing transactions (for truly uncategorised rows)
    let newTxnIds = [];
    if (uncatIdsToCreate.length > 0) {
      const { data: uncatRows } = await supabase
        .from('uncategorized_transactions')
        .select('uncategorized_transaction_id, account_id, document_id, txn_date, details, debit, credit')
        .in('uncategorized_transaction_id', uncatIdsToCreate)
        .eq('user_id', userId);

      if (uncatRows && uncatRows.length > 0) {
        const insertPayload = uncatRows.map(row => ({
          user_id: userId,
          base_account_id: row.account_id,
          offset_account_id: offset_account_id,
          document_id: row.document_id,
          transaction_date: row.txn_date,
          details: row.details,
          amount: row.debit || row.credit,
          transaction_type: row.debit > 0 ? 'EXPENSE' : 'INCOME',
          categorised_by: 'MANUAL',
          confidence_score: 1.00,
          posting_status: 'POSTED',
          review_status: 'APPROVED',
          attention_level: 'LOW',
          uncategorized_transaction_id: row.uncategorized_transaction_id
        }));

        const { data: insertedTxns, error: insertError } = await supabase
          .from('transactions')
          .insert(insertPayload)
          .select('transaction_id');

        if (insertError) {
          console.error('Bulk insert error in assign/approve:', insertError);
          return res.status(500).json({ error: 'Failed to assign and approve missing transactions.' });
        }
        newTxnIds = insertedTxns ? insertedTxns.map(t => t.transaction_id) : [];
      }
    }

    const approvedIds = [...(updatedTxns ? updatedTxns.map(t => t.transaction_id) : []), ...newTxnIds];
    const approvedCount = approvedIds.length;

    res.status(200).json({ success: true, approved_count: approvedCount });

    // Background processing
    if (approvedIds.length > 0) {
      setImmediate(async () => {
        try {
          const { data: txnRows } = await supabase
            .from('transactions')
            .select('transaction_id, base_account_id, offset_account_id, amount, transaction_type, transaction_date, details, clean_merchant_name, is_contra, extracted_id')
            .in('transaction_id', approvedIds)
            .eq('user_id', userId);

          if (!txnRows || txnRows.length === 0) return;

          const allLedgerRows = [];
          for (const txn of txnRows) {
            const entries = buildLedgerRows(txn, userId);
            allLedgerRows.push(...entries);
          }

          if (allLedgerRows.length > 0) {
            const { error: ledgerError } = await supabase.from('journal_entries').insert(allLedgerRows);
            if (ledgerError) console.error('Background bulk ledger insert failed:', ledgerError);
          }

          await Promise.all(txnRows.map(txn => {
            if (txn.is_contra) return Promise.resolve();
            if (txn.extracted_id) {
              return upsertExactCache(userId, txn.extracted_id, txn.offset_account_id);
            }
            const name = txn.clean_merchant_name || txn.details;
            return upsertVectorCache(userId, name, txn.offset_account_id);
          }));

          console.log(`✅ Background bulk assign & approve complete for ${txnRows.length} transactions`);
        } catch (bgError) {
          console.error('❌ Background bulk assign & approve processing failed:', bgError);
        }
      });
    }
  } catch (err) {
    console.error('Unexpected error in bulkAssignAndApproveTransactions:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * manualCategorizeTransaction(req, res)
 * Creates a new transaction row from an uncategorized transaction.
 * User manually selects the offset_account_id.
 * Transaction is created as APPROVED and POSTED.
 * Enforces user ownership.
 */
async function manualCategorizeTransaction(req, res) {
  try {
    const { uncategorized_transaction_id, offset_account_id, pending } = req.body;
    const userId = req.user?.id;
    // pending=true  → Save path: creates a PENDING/DRAFT row (no ledger, no cache)
    // pending=false → Approve path: creates an APPROVED/POSTED row (original behaviour)

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }

    if (!uncategorized_transaction_id || !offset_account_id) {
      return res.status(400).json({ error: 'Missing uncategorized_transaction_id or offset_account_id.' });
    }

    // Fetch the uncategorized transaction row (include group_id for Priority 0 similar-txn matching)
    const { data: uncatData, error: uncatError } = await supabase
      .from('uncategorized_transactions')
      .select('account_id, document_id, txn_date, details, debit, credit, group_id')
      .eq('uncategorized_transaction_id', uncategorized_transaction_id)
      .eq('user_id', userId)
      .single();

    if (uncatError || !uncatData) {
      console.error('Failed to fetch uncategorized transaction:', uncatError);
      return res.status(404).json({ error: 'Uncategorized transaction not found.' });
    }

    // Create transaction row
    const { error: insertError } = await supabase
      .from('transactions')
      .insert([{
        user_id: userId,
        base_account_id: uncatData.account_id,
        offset_account_id: offset_account_id,
        document_id: uncatData.document_id,
        transaction_date: uncatData.txn_date,
        details: uncatData.details,
        amount: uncatData.debit || uncatData.credit,
        transaction_type: uncatData.debit > 0 ? 'EXPENSE' : 'INCOME',
        categorised_by: 'MANUAL',
        confidence_score: 1.00,
        posting_status: pending ? 'DRAFT'  : 'POSTED',
        review_status:  pending ? 'PENDING': 'APPROVED',
        attention_level: 'LOW',
        is_uncategorised: false,
        uncategorized_transaction_id: uncategorized_transaction_id
      }]);

    if (insertError) {
      if (insertError.code === '23505') {
        // Unique constraint violation — already processed, safe to ignore
        console.warn(`⚠️ Duplicate skipped for uncategorized txn ${uncategorized_transaction_id}: already categorized`);
        return res.status(200).json({ success: true, note: 'already_approved' });
      }
      console.error('Failed to create transaction:', insertError);
      return res.status(500).json({ error: 'Failed to save categorization.' });
    }

    // Fetch the newly created transaction to get its generated ID
    const { data: newTxn } = await supabase
      .from('transactions')
      .select('transaction_id, base_account_id, offset_account_id, amount, transaction_type, transaction_date, extracted_id')
      .eq('uncategorized_transaction_id', uncategorized_transaction_id)
      .eq('user_id', userId)
      .single();

    let similarTransactions = [];
    let suggestedAccount = null;

    // For the pending/Save path we skip ledger creation, cache seeding and
    // similar-transaction matching — those run when the row is eventually approved.
    if (!pending && newTxn) {
      await createLedgerEntries(
        newTxn.transaction_id,
        newTxn.base_account_id,
        newTxn.offset_account_id,
        newTxn.amount,
        newTxn.transaction_type,
        newTxn.transaction_date,
        false,
        userId
      );

      // Fetch account name for suggestedAccount
      const { data: suggestedAccountData } = await supabase
        .from('accounts')
        .select('account_id, account_name')
        .eq('account_id', newTxn.offset_account_id)
        .single();

      suggestedAccount = suggestedAccountData || null;

      // Re-run rules engine on raw details — used for both similar-txn matching
      // and cache seeding below. Runs once here and shared between both sections.
      const rawDetails = uncatData.details || '';
      const rulesResult = rulesEngineService.evaluateTransaction(rawDetails);

      // If extracted_id wasn't stored (e.g. was dumped before bulkController fix),
      // recover it now from the rules engine so the similar-txn query can use it.
      let effectiveExtractedId = newTxn.extracted_id;
      if (!effectiveExtractedId && rulesResult.hasRuleMatch && rulesResult.extractedId) {
        effectiveExtractedId = rulesResult.extractedId;
      }

      // ── Priority 0: group_id matching ──────────────────────────────────────
      // Surface group members that are not yet APPROVED.
      // Two buckets:
      //   a) Already in transactions as PENDING — shown as regular similar txns
      //   b) Not yet in transactions at all (pre-pipeline) — shown as is_pre_pipeline
      //
      // group_id already available from uncatData (fetched above with group_id in select).
      const groupId = uncatData.group_id;

      if (groupId) {
        // Priority 0a: Fetch sibling uncategorized_transaction_ids for this group from the
        // source table first, then use .in() on transactions — this guarantees correct DB-side
        // filtering without relying on the broken PostgREST join-filter syntax.
        const { data: siblingUncatRows } = await supabase
          .from('uncategorized_transactions')
          .select('uncategorized_transaction_id')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .neq('uncategorized_transaction_id', uncategorized_transaction_id)
          .neq('grouping_status', 'skipped');

        const siblingUncatIds = (siblingUncatRows || []).map(r => r.uncategorized_transaction_id);

        if (siblingUncatIds.length > 0) {
          const { data: pendingGroupTxns } = await supabase
            .from('transactions')
            .select(`
              transaction_id,
              uncategorized_transaction_id,
              amount,
              transaction_type,
              transaction_date,
              details,
              extracted_id,
              offset_account_id,
              attention_level,
              current_account:offset_account_id ( account_id, account_name )
            `)
            .eq('user_id', userId)
            .eq('review_status', 'PENDING')
            .in('uncategorized_transaction_id', siblingUncatIds)
            .limit(20);

          if (pendingGroupTxns && pendingGroupTxns.length > 0) {
            similarTransactions = pendingGroupTxns;
          }
        }

        // b) Pre-pipeline members: uncategorized rows in the group with no transactions row yet.
        if (similarTransactions.length === 0 && siblingUncatIds.length > 0) {
          const { data: prePipelineRaw } = await supabase
            .from('uncategorized_transactions')
            .select(`
              uncategorized_transaction_id, details, txn_date, debit, credit, account_id,
              txn_check:transactions ( uncategorized_transaction_id )
            `)
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .neq('uncategorized_transaction_id', uncategorized_transaction_id)
            .neq('grouping_status', 'skipped')
            .is('txn_check', null)
            .limit(20);

          if (prePipelineRaw && prePipelineRaw.length > 0) {
            similarTransactions = prePipelineRaw.map(m => ({
              transaction_id: null,
              amount: m.debit || m.credit,
              transaction_type: m.debit ? 'EXPENSE' : 'INCOME',
              transaction_date: m.txn_date,
              details: m.details,
              offset_account_id: null,
              attention_level: 'HIGH',
              current_account: null,
              uncategorized_transaction_id: m.uncategorized_transaction_id,
              is_pre_pipeline: true
            }));
          }
        }
      }

      // If Priority 0 found results, skip Priority 1 and Priority 2
      if (similarTransactions.length === 0) {
        // Build match condition for similar transactions
        let similarQuery = supabase
          .from('transactions')
          .select(`
            transaction_id,
            uncategorized_transaction_id,
            amount,
            transaction_type,
            transaction_date,
            details,
            extracted_id,
            offset_account_id,
            attention_level,
            current_account:offset_account_id (
              account_id,
              account_name
            )
          `)
          .eq('user_id', userId)
          .eq('transaction_type', newTxn.transaction_type)
          .neq('transaction_id', newTxn.transaction_id);

        // Priority 1: match on extracted_id — includes approved history so the user
        //             can see past categorisation decisions as a reference.
        // Priority 2: fallback to same offset_account_id, HIGH/MEDIUM attention only,
        //             limited to categorised PENDING rows (more conservative since less precise).
        if (effectiveExtractedId) {
          similarQuery = similarQuery
            .eq('extracted_id', effectiveExtractedId)
            .order('transaction_date', { ascending: false });
        } else {
          similarQuery = similarQuery
            .eq('review_status', 'PENDING')
            .eq('offset_account_id', newTxn.offset_account_id)
            .eq('is_uncategorised', false)
            .in('attention_level', ['HIGH', 'MEDIUM']);
        }

        const { data: similar } = await similarQuery.limit(20);
        similarTransactions = similar || [];
      }
      // ── End similar transaction logic ─────────────────────────────────────

      // Seed personal cache — rulesResult already computed above
      // Cover both EXACT_THEN_DUMP (paytmqr, bharatpe etc.) and VECTOR_SEARCH rules
      if (rulesResult.hasRuleMatch && rulesResult.extractedId &&
          (rulesResult.strategy === 'EXACT_THEN_DUMP' || rulesResult.strategy === 'VECTOR_SEARCH')) {
        // Store the extracted ID in exact cache
        console.log(`💾 Storing in exact cache: "${rulesResult.extractedId}" for transaction: "${rawDetails}"`);
        await upsertExactCache(userId, rulesResult.extractedId, newTxn.offset_account_id);
      } else if (isGarbage(rawDetails)) {
        // Store raw garbage string in exact cache
        console.log(`💾 Storing garbage in exact cache: "${rawDetails.trim()}"`);
        await upsertExactCache(userId, rawDetails.trim(), newTxn.offset_account_id);
      } else {
        // Store the raw details (or clean_merchant_name) directly in vector cache
        // NER has been removed — Regex Cleaner in the bulk pipeline handles cleaning
        const cleanName = rawDetails;
        console.log(`💾 Storing in vector cache: "${cleanName}" for transaction: "${rawDetails}"`);
        await upsertVectorCache(userId, cleanName, newTxn.offset_account_id);
      }
    }

    return res.status(200).json({
      success: true,
      transaction_id: newTxn?.transaction_id ?? null,
      pending: !!pending,
      similarTransactions,
      suggestedAccount
    });
  } catch (err) {
    console.error('Unexpected error in manualCategorizeTransaction:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * correctTransaction(req, res)
 * Corrects the amount and/or transaction_type (DEBIT/CREDIT) of a parsed transaction.
 *
 * Strategy: Clean Slate
 *   1. Guard against POSTED and contra transactions.
 *   2. Delete journal_entries (FK must go first).
 *   3. Delete the transactions row.
 *   4. Update uncategorized_transactions with corrected values and reset to PENDING.
 *
 * The transaction will reappear in the uncategorized queue for re-categorization.
 */
async function correctTransaction(req, res) {
  try {
    const { uncategorized_transaction_id } = req.params;
    const { amount, transaction_type, details, txn_date, base_account_id, user_note } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }

    // Input validation
    if (!uncategorized_transaction_id) {
      return res.status(400).json({ error: 'Missing uncategorized_transaction_id.' });
    }
    const hasAnyField = amount !== undefined || transaction_type !== undefined ||
                        details !== undefined || txn_date !== undefined ||
                        base_account_id !== undefined || user_note !== undefined;
    if (!hasAnyField) {
      return res.status(400).json({ error: 'At least one correctable field must be provided.' });
    }
    if (amount !== undefined && (isNaN(amount) || Number(amount) < 0)) {
      return res.status(400).json({ error: 'Amount must be a non-negative number.' });
    }
    if (transaction_type !== undefined && !['DEBIT', 'CREDIT'].includes(transaction_type)) {
      return res.status(400).json({ error: 'transaction_type must be DEBIT or CREDIT.' });
    }

    // ── 1. Fetch the existing transactions row ─────────────────────────────────
    const { data: existingTxn, error: fetchError } = await supabase
      .from('transactions')
      .select('transaction_id, posting_status, is_contra, amount, transaction_type, user_note')
      .eq('uncategorized_transaction_id', uncategorized_transaction_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (fetchError) {
      console.error('correctTransaction fetch error:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch transaction.' });
    }

    // Preserve user_note across the clean-slate cycle.
    // Priority: new note from request > existing note on the transactions row.
    const preservedNote = user_note !== undefined ? user_note : (existingTxn?.user_note || null);

    if (existingTxn) {
      // Guard: Block edits on POSTED transactions
      if (existingTxn.posting_status === 'POSTED') {
        return res.status(403).json({
          error: 'Cannot correct a POSTED transaction. Posted entries are locked. Please raise a manual reversal.'
        });
      }

      // Guard: Block edits on contra-paired transactions
      if (existingTxn.is_contra) {
        return res.status(403).json({
          error: 'Cannot correct a contra-paired transaction. Edit both legs manually.'
        });
      }

      // ── 2. Delete journal_entries first (FK constraint) ──────────────────────
      const { error: ledgerDeleteError } = await supabase
        .from('journal_entries')
        .delete()
        .eq('transaction_id', existingTxn.transaction_id);

      if (ledgerDeleteError) {
        console.error('correctTransaction ledger delete error:', ledgerDeleteError);
        return res.status(500).json({ error: 'Failed to remove ledger entries.' });
      }

      // ── 3. Delete the transactions row ─────────────────────────────────────
      const { error: txnDeleteError } = await supabase
        .from('transactions')
        .delete()
        .eq('transaction_id', existingTxn.transaction_id)
        .eq('user_id', userId);

      if (txnDeleteError) {
        console.error('correctTransaction txn delete error:', txnDeleteError);
        return res.status(500).json({ error: 'Failed to remove transaction.' });
      }
    }
    // If no transactions row exists yet (still PENDING), we still correct the source.

    // ── 4. Build the corrected uncategorized_transaction update ───────────────
    // Only re-derive and write debit/credit when the caller explicitly sent
    // amount or transaction_type. If neither was provided, leave the original
    // columns alone — otherwise an uncategorised row (where existingTxn is null)
    // would get finalType=undefined/finalAmount=undefined, wiping the DB values.
    const finalType = transaction_type || existingTxn?.transaction_type;
    const finalAmount = amount !== undefined
      ? parseFloat(Number(amount).toFixed(2))
      : existingTxn?.amount;

    const uncatUpdate = {
      status: 'PENDING'
    };

    // Amount / type fields — only touch debit/credit if the user changed them
    if (amount !== undefined || transaction_type !== undefined) {
      if (finalType === 'DEBIT') {
        uncatUpdate.debit  = finalAmount;
        uncatUpdate.credit = null;
      } else {
        uncatUpdate.credit = finalAmount;
        uncatUpdate.debit  = null;
      }
    }

    // Extended editable fields
    if (details !== undefined)       uncatUpdate.details      = details;
    if (txn_date !== undefined)      uncatUpdate.txn_date     = txn_date;
    if (base_account_id !== undefined) uncatUpdate.account_id  = base_account_id;

    const { error: uncatUpdateError } = await supabase
      .from('uncategorized_transactions')
      .update(uncatUpdate)
      .eq('uncategorized_transaction_id', uncategorized_transaction_id)
      .eq('user_id', userId);

    if (uncatUpdateError) {
      console.error('correctTransaction uncategorized update error:', uncatUpdateError);
      return res.status(500).json({ error: 'Failed to update source transaction.' });
    }

    console.log(`✅ Transaction corrected: uncategorized_transaction_id=${uncategorized_transaction_id}, type=${finalType}, amount=${finalAmount}`);

    return res.status(200).json({
      success: true,
      message: 'Transaction corrected and reset to PENDING. Please re-categorize.',
      preserved_note: preservedNote,
      corrected: {
        uncategorized_transaction_id,
        transaction_type: finalType,
        amount: finalAmount,
        details: uncatUpdate.details,
        txn_date: uncatUpdate.txn_date,
        account_id: uncatUpdate.account_id
      }
    });

  } catch (err) {
    console.error('Unexpected error in correctTransaction:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * updateTransactionNote(req, res)
 * Updates only the user_note field on an already-approved or already-categorised
 * transactions row. Does NOT trigger a clean-slate correction cycle.
 * Route: PATCH /transactions/:transaction_id/note
 */
async function updateTransactionNote(req, res) {
  try {
    const { transaction_id } = req.params;
    const { user_note } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }

    if (!transaction_id) {
      return res.status(400).json({ error: 'Missing transaction_id.' });
    }

    if (user_note !== undefined && typeof user_note !== 'string') {
      return res.status(400).json({ error: 'user_note must be a string.' });
    }

    const noteValue = user_note !== undefined ? user_note.slice(0, 500) : null;

    const { error } = await supabase
      .from('transactions')
      .update({ user_note: noteValue })
      .eq('transaction_id', transaction_id)
      .eq('user_id', userId);

    if (error) {
      console.error('updateTransactionNote error:', error);
      return res.status(500).json({ error: 'Failed to update note.' });
    }

    console.log(`✅ Note updated for transaction ${transaction_id}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Unexpected error in updateTransactionNote:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}
/**
 * updateSourceAccount(req, res)
 * Updates the base account (source_account) of an uncategorized transaction.
 * If the transaction is already categorized, it checks if it is POSTED and errors if so.
 * Otherwise it also updates the transactions.base_account_id.
 */
async function updateSourceAccount(req, res) {
  try {
    const { uncategorized_transaction_id } = req.params;
    const { account_id } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }

    if (!uncategorized_transaction_id || !account_id) {
      return res.status(400).json({ error: 'Missing uncategorized_transaction_id or account_id.' });
    }

    // Check if we can change it. 
    // Guard: Block edits on POSTED transactions
    const { data: existingTxns, error: fetchError } = await supabase
      .from('transactions')
      .select('transaction_id, posting_status')
      .eq('uncategorized_transaction_id', uncategorized_transaction_id)
      .eq('user_id', userId);

    if (existingTxns && existingTxns.length > 0) {
      const posted = existingTxns.some(t => t.posting_status === 'POSTED');
      if (posted) {
        return res.status(403).json({ error: 'Cannot edit base account of a POSTED transaction.' });
      }

      // Update base_account_id in transactions
      const { error: txnUpdateError } = await supabase
        .from('transactions')
        .update({ base_account_id: account_id })
        .eq('uncategorized_transaction_id', uncategorized_transaction_id)
        .eq('user_id', userId);
        
      if (txnUpdateError) {
        return res.status(500).json({ error: 'Failed to update transaction base account.' });
      }
    }

    // Update account_id in uncategorized_transactions
    const { error: uncatUpdateError } = await supabase
      .from('uncategorized_transactions')
      .update({ account_id: account_id })
      .eq('uncategorized_transaction_id', uncategorized_transaction_id)
      .eq('user_id', userId);

    if (uncatUpdateError) {
      return res.status(500).json({ error: 'Failed to update source transaction account.' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Unexpected error in updateSourceAccount:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * manualAddTransaction(req, res)
 * Creates a brand-new transaction directly from user input — no uncategorized
 * transaction source needed. Immediately APPROVED and POSTED.
 * Body: { base_account_id, offset_account_id, amount, transaction_type, transaction_date, details, user_note? }
 */
async function manualAddTransaction(req, res) {
  try {
    const { base_account_id, offset_account_id, amount, transaction_type, transaction_date, details, user_note } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'User authentication failed.' });

    if (!base_account_id || !offset_account_id || !amount || !transaction_type || !transaction_date || !details) {
      return res.status(400).json({ error: 'Missing required fields: base_account_id, offset_account_id, amount, transaction_type, transaction_date, details.' });
    }
    if (!['DEBIT', 'CREDIT'].includes(transaction_type)) {
      return res.status(400).json({ error: 'transaction_type must be DEBIT or CREDIT.' });
    }
    if (isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number.' });
    }

    // Convert UI transaction_type (DEBIT/CREDIT) to DB enum value (EXPENSE/INCOME)
    const dbTransactionType = transaction_type === 'DEBIT' ? 'EXPENSE' : 'INCOME';

    // Create an uncategorized_transactions row first so it shows up in the UI list
    // document_id is omitted (will be NULL) since this is a manual transaction
    const { data: uncatRow, error: uncatErr } = await supabase
      .from('uncategorized_transactions')
      .insert([{
        user_id: userId,
        account_id: base_account_id,
        txn_date: transaction_date,
        details: details,
        debit: transaction_type === 'DEBIT' ? Number(amount) : null,
        credit: transaction_type === 'CREDIT' ? Number(amount) : null,
        status: 'CATEGORISED',
        grouping_status: 'done'
      }])
      .select('uncategorized_transaction_id')
      .single();

    if (uncatErr) {
      console.error('manualAddTransaction create uncat error:', uncatErr);
      return res.status(500).json({ error: 'Failed to create source transaction record.' });
    }

    const { data: newTxn, error: insertError } = await supabase
      .from('transactions')
      .insert([{
        user_id: userId,
        base_account_id,
        offset_account_id,
        transaction_date,
        details,
        amount: Number(amount),
        transaction_type: dbTransactionType,
        categorised_by: 'MANUAL',
        confidence_score: 1.00,
        posting_status: 'POSTED',
        review_status: 'APPROVED',
        attention_level: 'LOW',
        is_uncategorised: false,
        user_note: user_note || null,
        uncategorized_transaction_id: uncatRow.uncategorized_transaction_id
      }])
      .select('transaction_id')
      .single();

    if (insertError) {
      console.error('manualAddTransaction insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create transaction.' });
    }

    // Create ledger entries synchronously (no uncategorized row to clean up)
    await createLedgerEntries(
      newTxn.transaction_id,
      base_account_id,
      offset_account_id,
      Number(amount),
      transaction_type,
      transaction_date,
      false,
      userId
    );

    // Seed vector cache with description
    const rulesResult = rulesEngineService.evaluateTransaction(details);
    if (rulesResult.hasRuleMatch && rulesResult.extractedId) {
      await upsertExactCache(userId, rulesResult.extractedId, offset_account_id);
    } else {
      await upsertVectorCache(userId, details, offset_account_id);
    }

    return res.status(200).json({ success: true, transaction_id: newTxn.transaction_id });
  } catch (err) {
    console.error('Unexpected error in manualAddTransaction:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}


/**
 * retryPipeline(req, res)
 * Re-triggers the auto-pipeline for a document that is in pipeline_failed
 * state, or pipeline_running but stale (> 5 min since pipeline_started_at).
 * Route: POST /transactions/retry-pipeline
 * Body: { document_id }
 */
async function retryPipeline(req, res) {
  try {
    const { document_id } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }
    if (!document_id) {
      return res.status(400).json({ error: 'Missing document_id.' });
    }

    // 1. Verify the document belongs to this user
    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('document_id, user_id, grouping_status, pipeline_started_at')
      .eq('document_id', document_id)
      .eq('user_id', userId)
      .single();

    if (docErr || !doc) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    // 2. Allow retry for any "stuck" state:
    //   - pipeline_failed          : explicit run failure
    //   - pipeline_running (stale) : run hung for > 5 min
    //   - pending                  : grouping job never ran (parser backend was asleep)
    //   - done                     : grouping finished but auto-pipeline was never triggered
    const STALE_MS = 5 * 60 * 1000;
    const isStaleRunning =
      doc.grouping_status === 'pipeline_running' &&
      doc.pipeline_started_at &&
      Date.now() - new Date(doc.pipeline_started_at).getTime() > STALE_MS;

    const isRetryable =
      doc.grouping_status === 'pipeline_failed' ||
      doc.grouping_status === 'pending' ||
      doc.grouping_status === 'done' ||
      isStaleRunning;

    if (!isRetryable) {
      return res.status(409).json({
        error: `Cannot retry: document grouping_status is '${doc.grouping_status}'. Retry is only available for failed or stuck documents.`
      });
    }

    // 3. If the document never went through grouping ('pending'), promote all its
    //    uncategorized_transactions rows to grouping_status='done' so the
    //    auto-pipeline treats them as ready. The transactions are already in the DB
    //    (inserted at approval time) — the grouping job just never ran.
    if (doc.grouping_status === 'pending') {
      const { error: promoteErr } = await supabase
        .from('uncategorized_transactions')
        .update({ grouping_status: 'done' })
        .eq('document_id', document_id)
        .eq('user_id', userId)
        .neq('grouping_status', 'categorized'); // leave already-processed rows alone

      if (promoteErr) {
        console.error('[RETRY-PIPELINE] Failed to promote uncategorized rows:', promoteErr.message);
      } else {
        console.log(`[RETRY-PIPELINE] Promoted pending uncategorized_transactions to "done" for doc ${document_id}`);
      }
    }

    // 3b. Reset document to 'done' so auto-pipeline can pick it up again
    await supabase
      .from('documents')
      .update({
        grouping_status: 'done',
        pipeline_error: null,
        pipeline_started_at: null,
      })
      .eq('document_id', document_id);

    // 3b. Roll back any partially-written state from the failed run so the
    //     pipeline doesn't skip those rows on retry.
    //
    //     (i) uncategorized_transactions rows that were marked 'categorized'
    //         by the failed run must be reset so they are picked up again.
    //     (ii) DRAFT transactions rows written before the crash must be deleted
    //          so the idempotent upsert can rewrite them with correct data.
    //
    // First, find which uncategorized_transaction_ids for this doc were
    // already inserted as DRAFT (i.e. written by the failed run but never approved).
    const { data: draftTxns } = await supabase
      .from('transactions')
      .select('transaction_id, uncategorized_transaction_id')
      .eq('document_id', document_id)
      .eq('user_id', userId)
      .eq('posting_status', 'DRAFT');

    if (draftTxns && draftTxns.length > 0) {
      const draftTxnIds = draftTxns.map(t => t.transaction_id);
      const draftUncatIds = draftTxns.map(t => t.uncategorized_transaction_id).filter(Boolean);

      // Delete ledger entries first (FK constraint), then the transactions rows.
      await supabase.from('journal_entries').delete().in('transaction_id', draftTxnIds);
      await supabase.from('transactions').delete().in('transaction_id', draftTxnIds);

      // Reset the corresponding uncategorized_transactions back to 'done' so
      // the pipeline picks them up again.
      if (draftUncatIds.length > 0) {
        await supabase
          .from('uncategorized_transactions')
          .update({ grouping_status: 'done' })
          .in('uncategorized_transaction_id', draftUncatIds);
      }

      console.log(`[RETRY-PIPELINE] Rolled back ${draftTxnIds.length} draft transactions and reset ${draftUncatIds.length} uncategorized rows for doc ${document_id}`);
    }

    // Reset any 'skipped' uncategorized_transactions rows that don't yet have a
    // transactions row. The Python grouping job marks FAST_PATH / EXACT_THEN_DUMP
    // rows as 'skipped' (not 'done'), so the auto-pipeline's
    // grouping_status IN ('done','pipeline_running') filter misses them entirely.
    // On a retry we need them visible again — we only touch rows that have no
    // matching entry in transactions (i.e. not yet categorised).
    const { data: skippedUncat } = await supabase
      .from('uncategorized_transactions')
      .select('uncategorized_transaction_id')
      .eq('document_id', document_id)
      .eq('user_id', userId)
      .eq('grouping_status', 'skipped');

    if (skippedUncat && skippedUncat.length > 0) {
      const skippedIds = skippedUncat.map(r => r.uncategorized_transaction_id);

      // Only reset those that don't already have a transactions row
      const { data: alreadyCategorised } = await supabase
        .from('transactions')
        .select('uncategorized_transaction_id')
        .eq('document_id', document_id)
        .in('uncategorized_transaction_id', skippedIds);

      const alreadyDoneSet = new Set(
        (alreadyCategorised || []).map(r => r.uncategorized_transaction_id).filter(Boolean)
      );
      const needsReset = skippedIds.filter(id => !alreadyDoneSet.has(id));

      if (needsReset.length > 0) {
        await supabase
          .from('uncategorized_transactions')
          .update({ grouping_status: 'done' })
          .in('uncategorized_transaction_id', needsReset);

        console.log(`[RETRY-PIPELINE] Reset ${needsReset.length} 'skipped' uncategorized rows back to 'done' for doc ${document_id}`);
      }
    }

    // Also clear any stale llm_queue entries for this document so they don't
    // accumulate across retries.
    await supabase
      .from('llm_queue')
      .delete()
      .eq('document_id', document_id)
      .eq('status', 'pending');

    // 4. Re-trigger the auto-pipeline IN-PROCESS.
    //    A localhost HTTP self-call (http://localhost:PORT/internal/auto-pipeline)
    //    does NOT work on serverless (Vercel): there is no persistent port to call,
    //    and any fire-and-forget work is frozen the instant the response is sent.
    //    So we invoke the handler directly with a synthetic req/mock res and AWAIT
    //    it, guaranteeing the pipeline finishes within this invocation.
    //    (Same in-process pattern bulkController already uses.)
    try {
      const { runAutoPipeline } = require('./autoPipelineController');
      await runAutoPipeline(
        {
          headers: { authorization: `Bearer ${process.env.INTERNAL_SECRET}` },
          body: { document_id, user_id: userId },
        },
        { json: () => {}, status: () => ({ json: () => {} }) }
      );
    } catch (err) {
      console.error('[RETRY-PIPELINE] In-process auto-pipeline failed:', err.message);
      // Pipeline failure is non-fatal to the retry request itself — the document
      // status reflects the outcome and the user can retry again.
    }

    return res.json({ success: true, message: 'Pipeline complete' });
  } catch (err) {
    console.error('Unexpected error in retryPipeline:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

module.exports = {
  recategorizeTransaction,
  approveTransaction,
  bulkApproveTransactions,
  bulkAssignAndApproveTransactions,
  manualCategorizeTransaction,
  correctTransaction,
  updateSourceAccount,
  updateTransactionNote,
  manualAddTransaction,
  retryPipeline,
};
