const { supabase } = require('./backend/shared/supabase'); // adjust path if needed

async function checkData() {
  const userId = '7e6a3928-1ae7-4f1c-9cf1-cee0bee5af47';
  const { data, error } = await supabase
    .from('uncategorized_transactions')
    .select(`
      uncategorized_transaction_id,
      txn_date,
      details,
      debit,
      credit,
      account_id,
      transactions!uncategorized_transaction_id (
        transaction_id,
        offset_account_id,
        is_uncategorised,
        is_contra,
        accounts:offset_account_id (
          account_name,
          account_type
        )
      )
    `)
    .eq('user_id', userId)
    .limit(10);
    
  console.log("Raw query data:", JSON.stringify(data, null, 2));
}

checkData();
