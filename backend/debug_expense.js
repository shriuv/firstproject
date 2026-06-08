const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'c:/Users/SHREE/UV_PROJECT/LedgerAI/backend/.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {

    const { data: txns } = await supabase
        .from('uncategorized_transactions')
        .select(`
            *,
            source_account:account_id ( account_id, account_name, account_type ),
            transactions (
                transaction_id,
                transaction_type,
                amount,
                is_contra,
                is_uncategorised,
                accounts:offset_account_id ( account_id, account_name, account_type )
            )
        `);

    let totalExpense = 0;
    const expenseRows = [];

    for (const txn of txns) {
        let category = 'Uncategorized';
        let effectiveAccountType = null;
        let isContra = false;
        let isUncatDB = false;
        let isBase = false;

        const baseAccountType = txn.source_account?.account_type;

        if (txn.transactions && txn.transactions.length > 0) {
            const linkedTxn = txn.transactions[0];
            isContra = linkedTxn.is_contra === true;
            isUncatDB = linkedTxn.is_uncategorised === true;

            if (baseAccountType === 'EXPENSE' || baseAccountType === 'INCOME') {
                category = txn.source_account?.account_name || 'Uncategorized';
                effectiveAccountType = baseAccountType;
                isBase = true;
            } else if (linkedTxn.accounts) {
                category = linkedTxn.accounts.account_name;
                effectiveAccountType = linkedTxn.accounts.account_type;
            }
        }

        if (isContra) continue;

        const catLower = category.toLowerCase().trim();
        const isUncategorised =
            isUncatDB ||
            effectiveAccountType === null ||
            catLower.includes('uncategor');
            // skipping full string checks for brevity

        if (isUncategorised) continue;

        if (effectiveAccountType === 'EXPENSE') {
            const expenseAmt = isBase ? txn.debit : txn.credit;
            if (expenseAmt > 0) {
                totalExpense += expenseAmt;
                expenseRows.push({
                    details: txn.details,
                    category,
                    amount: expenseAmt,
                    isBase,
                    debit: txn.debit,
                    credit: txn.credit
                });
            }
        }
    }

    console.log('Total Expense Calculated:', totalExpense);
    console.table(expenseRows);
}

run();
