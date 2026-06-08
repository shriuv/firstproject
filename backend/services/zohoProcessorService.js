/**
 * zohoProcessorService.js
 *
 * Reads raw staged records from zoho_imports (processed = false)
 * and inserts them through the full LedgerAI pipeline:
 *
 *   zoho_imports (raw)
 *       ↓
 *   uncategorized_transactions  (parent — what DataContext queries)
 *       ↓
 *   transactions                (child — joined via uncategorized_transaction_id)
 *
 * This makes Zoho data appear in Overview, Transactions page, and Analytics.
 */

async function markProcessed(supabase, id, error = null) {
    await supabase
        .from('zoho_imports')
        .update({
            processed: !error,
            processed_at: error ? null : new Date().toISOString(),
            processing_error: error || null,
            updated_at: new Date().toISOString(),
        })
        .eq('id', id);
}

// FIX 1: Added `zoho_` prefix to external_id lookup so it matches how COA migration stores account IDs
async function resolveAccount(supabase, userId, zohoAccountId, fallbackType = null) {
    if (zohoAccountId) {
        const { data } = await supabase
            .from('accounts')
            .select('account_id, account_type, account_name')
            .eq('user_id', userId)
            .eq('external_id', `zoho_${zohoAccountId}`)  // FIX: added zoho_ prefix
            .maybeSingle();
        if (data) return data;
    }
    if (fallbackType) {
        const { data } = await supabase
            .from('accounts')
            .select('account_id, account_type, account_name')
            .eq('user_id', userId)
            .eq('account_type', fallbackType)
            .limit(1)
            .maybeSingle();
        if (data) return data;
    }
    return null;
}

async function insertThroughPipeline(supabase, uncatRow, txnRow, externalId, singleJournalRow = null) {
    // Check if transactions row already exists for this external_id
    const { data: existing } = await supabase
        .from('transactions')
        .select('uncategorized_transaction_id, external_id')
        .eq('user_id', uncatRow.user_id)
        .eq('external_id', externalId)
        .maybeSingle();

    if (existing) return true; // Already fully processed — skip

    // No existing transactions row — always create a fresh uncategorized_transactions row
    const { data: uncatData, error: uncatError } = await supabase
        .from('uncategorized_transactions')
        .insert(uncatRow)
        .select('uncategorized_transaction_id')
        .single();

    if (uncatError) {
        console.warn(`uncategorized_transactions insert failed: ${uncatError.message}`);
        return false;
    }

    const uncatId = uncatData.uncategorized_transaction_id;

    // FIX 2: Removed single_journal_entry from txnRow before insert — that column does not exist in transactions table
    const { single_journal_entry, ...cleanTxnRow } = txnRow;

    const { data: txnData, error: txnError } = await supabase
        .from('transactions')
        .insert({ ...cleanTxnRow, uncategorized_transaction_id: uncatId, external_id: externalId })
        .select('transaction_id')
        .single();

    if (txnError) {
        console.warn(`transactions insert failed for ${externalId}: ${txnError.message}`);
        await supabase
            .from('uncategorized_transactions')
            .delete()
            .eq('uncategorized_transaction_id', uncatId);
        return false;
    }

    // CREATE JOURNAL ENTRIES
    if (txnRow.posting_status === 'POSTED' && !txnRow.is_contra) {
        const amount = txnRow.amount;
        const base = txnRow.base_account_id;
        const offset = txnRow.offset_account_id;

        if (base && offset && amount) {
            let jRows;
            if (txnRow.transaction_type === 'DEBIT') {
                // Money OUT: debit base, credit offset
                jRows = [
                    { account_id: base, debit_amount: amount, credit_amount: 0 },
                    { account_id: offset, debit_amount: 0, credit_amount: amount },
                ];
            } else {
                // Money IN: credit base, debit offset
                jRows = [
                    { account_id: base, debit_amount: 0, credit_amount: amount },
                    { account_id: offset, debit_amount: amount, credit_amount: 0 },
                ];
            }

            const journalRows = jRows.map(e => ({
                transaction_id: txnData.transaction_id,
                account_id: e.account_id,
                debit_amount: e.debit_amount,
                credit_amount: e.credit_amount,
                entry_date: txnRow.transaction_date,
                user_id: txnRow.user_id,
            }));

            await supabase.from('journal_entries').insert(journalRows);

        } else if (base && amount && !offset && singleJournalRow) {
            // Single-legged entry (bank txns with no offset, paid bills)
            await supabase.from('journal_entries').insert([{
                transaction_id: txnData.transaction_id,
                account_id: base,
                debit_amount: singleJournalRow.debit_amount || 0,
                credit_amount: singleJournalRow.credit_amount || 0,
                entry_date: txnRow.transaction_date,
                user_id: txnRow.user_id,
            }]);
        }
    }

    return true;
}

// ─── Journal Processor ────────────────────────────────────────────────────────

async function processJournals(userId, supabase) {
    const { data: staged, error } = await supabase
        .from('zoho_imports')
        .select('*')
        .eq('user_id', userId)
        .eq('zoho_raw_type', 'journal')
        .eq('processed', false);

    if (error) throw new Error(`Failed to fetch staged journals: ${error.message}`);
    if (!staged?.length) return { count: 0 };

    let count = 0;

    for (const record of staged) {
        const journal = record.raw_payload;
        const lineItems = journal.line_items || [];

        if (lineItems.length < 2) {
            await markProcessed(supabase, record.id, 'Journal has fewer than 2 line items');
            continue;
        }

        const debits = lineItems.filter(l => l.debit_or_credit === 'debit');
        const credits = lineItems.filter(l => l.debit_or_credit === 'credit');

        let journalSuccess = true;

        for (const line of lineItems) {
            const isDebit = line.debit_or_credit === 'debit';

            // resolveAccount now uses zoho_ prefix automatically
            const lineAccount = await resolveAccount(supabase, userId, line.account_id, null);
            const lineAccountId = lineAccount?.account_id;

            const opposites = isDebit ? credits : debits;
            const offsetZohoId = opposites[0]?.account_id || null;
            const offsetAccount = offsetZohoId ? await resolveAccount(supabase, userId, offsetZohoId, null) : null;
            const offsetAccountId = offsetAccount?.account_id || null;

            if (!lineAccountId) {
                console.warn(`Journal ${journal.journal_id}: could not resolve account ${line.account_id}`);
                journalSuccess = false;
                continue;
            }

            const lineIndex = lineItems.indexOf(line);
            const externalId = `zoho_journal_${journal.journal_id}_line_${lineIndex}`;
            const amount = parseFloat(line.amount) || 0;
            const details = journal.notes || journal.reference_number || 'Imported from Zoho Books';

            const uncatRow = {
                user_id: userId,
                account_id: lineAccountId,
                txn_date: journal.journal_date,
                details,
                debit: isDebit ? amount : null,
                credit: isDebit ? null : amount,
                balance: null,
                status: 'CATEGORISED',
            };

            const txnRow = {
                user_id: userId,
                base_account_id: lineAccountId,
                offset_account_id: offsetAccountId,
                transaction_date: journal.journal_date,
                details,
                amount,
                transaction_type: isDebit ? 'DEBIT' : 'CREDIT',
                categorised_by: 'MANUAL',
                confidence_score: 1.00,
                posting_status: 'POSTED',
                attention_level: 'LOW',
                review_status: 'APPROVED',
                source: 'zoho_import',
                is_contra: !isDebit,
                is_uncategorised: false,
            };

            console.log(`[Journal] ${externalId} isDebit=${isDebit} is_contra=${!isDebit} amount=${amount}`);

            const ok = await insertThroughPipeline(supabase, uncatRow, txnRow, externalId);
            if (ok) count++;
            else journalSuccess = false;
        }

        await markProcessed(supabase, record.id, journalSuccess ? null : 'Some lines failed');
    }

    console.log(`[Processor] Processed ${count} journal lines`);
    return { count };
}

// ─── Invoice Processor ────────────────────────────────────────────────────────

async function processInvoices(userId, supabase) {
    const { data: staged, error } = await supabase
        .from('zoho_imports')
        .select('*')
        .eq('user_id', userId)
        .eq('zoho_raw_type', 'invoice')
        .eq('processed', false);

    if (error) throw new Error(`Failed to fetch staged invoices: ${error.message}`);
    if (!staged?.length) return { count: 0 };

    let count = 0;

    for (const record of staged) {
        const invoice = record.raw_payload;

        const receivableAccount = await resolveAccount(supabase, userId, invoice.accounts_receivable_account_id, 'ASSET');
        const receivableAccountId = receivableAccount?.account_id;

        const incomeAccount = await resolveAccount(supabase, userId, null, 'INCOME');
        const incomeAccountId = incomeAccount?.account_id;

        if (!receivableAccountId) {
            console.warn('[Processor] No ASSET account resolved — invoice skipped');
            await markProcessed(supabase, record.id, 'No ASSET account resolved');
            continue;
        }

        const amount = parseFloat(invoice.total) || 0;
        const details = `Invoice #${invoice.invoice_number} — ${invoice.customer_name}`;
        const externalId = `zoho_invoice_${invoice.invoice_id}`;

        const uncatRow = {
            user_id: userId,
            account_id: receivableAccountId,
            txn_date: invoice.date,
            details,
            debit: amount,   // asset increases (debit)
            credit: null,
            balance: null,
            status: 'CATEGORISED',
        };

        const txnRow = {
            user_id: userId,
            base_account_id: receivableAccountId,
            offset_account_id: incomeAccountId || null,
            transaction_date: invoice.date,
            details,
            amount,
            transaction_type: 'DEBIT',
            categorised_by: 'MANUAL',
            confidence_score: 1.00,
            posting_status: 'POSTED',
            attention_level: 'LOW',
            review_status: 'APPROVED',
            source: 'zoho_import',
            is_contra: false,
            is_uncategorised: false,
        };

        const ok = await insertThroughPipeline(supabase, uncatRow, txnRow, externalId);
        if (ok) count++;
        await markProcessed(supabase, record.id, ok ? null : 'Insert failed');
    }

    console.log(`[Processor] Processed ${count} invoices`);
    return { count };
}

// ─── Bill Processor ───────────────────────────────────────────────────────────

async function processBills(userId, supabase) {
    const { data: staged, error } = await supabase
        .from('zoho_imports')
        .select('*')
        .eq('user_id', userId)
        .eq('zoho_raw_type', 'bill')
        .eq('processed', false);

    if (error) throw new Error(`Failed to fetch staged bills: ${error.message}`);
    if (!staged?.length) return { count: 0 };

    let count = 0;

    for (const record of staged) {
        const bill = record.raw_payload;

        // Dynamically resolve expense account from Zoho's line item account_id
        const lineItemAccountId = bill.line_items?.[0]?.account_id || null;
        const expenseAccount = await resolveAccount(supabase, userId, lineItemAccountId, 'EXPENSE');
        const expenseAccountId = expenseAccount?.account_id;

        // Dynamically resolve liability account from Zoho's accounts_payable_account_id
        const liabilityAccount = await resolveAccount(supabase, userId, bill.accounts_payable_account_id, 'LIABILITY');
        const liabilityAccountId = liabilityAccount?.account_id;

        if (!expenseAccountId) {
            console.warn('[Processor] No EXPENSE account resolved — bill skipped');
            await markProcessed(supabase, record.id, 'No EXPENSE account resolved');
            continue;
        }

        const amount = parseFloat(bill.total) || 0;
        const details = `Bill #${bill.bill_number} — ${bill.vendor_name}`;
        const externalId = `zoho_bill_${bill.bill_id}`;

        const isPaid = bill.status?.toLowerCase() === 'paid';

        // Paid bills: straight expense, no liability
        // Unpaid bills: liability as base, expense as offset
        const baseAccountId = isPaid ? expenseAccountId : liabilityAccountId;
        const offsetAccountId = isPaid ? null : expenseAccountId;

        console.log(`[Bills] Bill ${bill.bill_id} isPaid=${isPaid} base=${baseAccountId} offset=${offsetAccountId}`);

        const uncatRow = {
            user_id: userId,
            account_id: baseAccountId,
            txn_date: bill.date,
            details,
            debit: isPaid ? amount : null,
            credit: isPaid ? null : amount,
            balance: null,
            status: 'CATEGORISED',
        };

        // FIX 2: Removed single_journal_entry from txnRow entirely
        const txnRow = {
            user_id: userId,
            base_account_id: baseAccountId,
            offset_account_id: offsetAccountId,
            transaction_date: bill.date,
            details,
            amount,
            transaction_type: isPaid ? 'DEBIT' : 'CREDIT',
            categorised_by: 'MANUAL',
            confidence_score: 1.00,
            posting_status: 'POSTED',
            attention_level: 'LOW',
            review_status: 'APPROVED',
            source: 'zoho_import',
            is_contra: false,
            is_uncategorised: false,
        };

        const ok = await insertThroughPipeline(supabase, uncatRow, txnRow, externalId, null);
        if (ok) count++;
        await markProcessed(supabase, record.id, ok ? null : 'Insert failed');
    }

    console.log(`[Processor] Processed ${count} bills`);
    return { count };
}

// ─── Bank Transaction Processor ───────────────────────────────────────────────

async function processBankTransactions(userId, supabase) {
    const { data: staged, error } = await supabase
        .from('zoho_imports')
        .select('*')
        .eq('user_id', userId)
        .eq('zoho_raw_type', 'bank_txn')
        .eq('processed', false);

    if (error) throw new Error(`Failed to fetch staged bank txns: ${error.message}`);
    if (!staged?.length) return { count: 0 };

    let count = 0;
    const depositTypes = ['deposit', 'customer_payment', 'interest_income', 'other_income', 'refund'];

    for (const record of staged) {
        const txn = record.raw_payload;

        // Dynamically resolve bank account from Zoho's account_id
        const bankAccount = await resolveAccount(supabase, userId, txn.account_id, 'ASSET');
        const bankAccountId = bankAccount?.account_id;

        if (!bankAccountId) {
            console.warn('[Processor] No ASSET account resolved for bank txn — skipped');
            await markProcessed(supabase, record.id, 'No ASSET account resolved');
            continue;
        }

        const isDeposit = depositTypes.includes(txn.transaction_type?.toLowerCase());
        const amount = parseFloat(txn.amount) || 0;
        const details = txn.payee || txn.description || txn.reference_number || 'Bank Transaction';
        const externalId = `zoho_bank_${txn.transaction_id}`;

        const uncatRow = {
            user_id: userId,
            account_id: bankAccountId,
            txn_date: txn.date,
            details,
            debit: isDeposit ? amount : null,
            credit: isDeposit ? null : amount,
            balance: null,
            status: 'CATEGORISED',
        };

        const txnRow = {
            user_id: userId,
            base_account_id: bankAccountId,
            offset_account_id: null,
            transaction_date: txn.date,
            details,
            amount,
            transaction_type: isDeposit ? 'DEBIT' : 'CREDIT',
            categorised_by: 'MANUAL',
            confidence_score: 1.00,
            posting_status: 'POSTED',
            attention_level: 'LOW',
            review_status: 'APPROVED',
            source: 'zoho_import',
            is_contra: false,
            is_uncategorised: false,
        };

        const singleJournalRow = {
            debit_amount: isDeposit ? amount : 0,
            credit_amount: isDeposit ? 0 : amount,
        };
        const ok = await insertThroughPipeline(supabase, uncatRow, txnRow, externalId, singleJournalRow);
        if (ok) count++;
        await markProcessed(supabase, record.id, ok ? null : 'Insert failed');
    }

    console.log(`[Processor] Processed ${count} bank transactions`);
    return { count };
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function runProcessor(userId, supabase) {
    console.log('[Processor] Starting pipeline for user:', userId);

    console.log('[Processor] STEP 1 - Processing journals');
    const { count: journalCount } = await processJournals(userId, supabase);

    console.log('[Processor] STEP 2 - Processing invoices');
    const { count: invoiceCount } = await processInvoices(userId, supabase);

    console.log('[Processor] STEP 3 - Processing bills');
    const { count: billCount } = await processBills(userId, supabase);

    console.log('[Processor] STEP 4 - Processing bank transactions');
    const { count: bankCount } = await processBankTransactions(userId, supabase);

    console.log('[Processor] Done.');

    return {
        journalLinesProcessed: journalCount,
        invoicesProcessed: invoiceCount,
        billsProcessed: billCount,
        bankTxnsProcessed: bankCount,
    };
}

module.exports = { runProcessor };