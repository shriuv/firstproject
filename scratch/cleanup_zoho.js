require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });
const supabase = require('../backend/config/supabaseClient');

async function cleanup() {
  const userId = '7e6a3928-1ae7-4f1c-9cf1-cee0bee5af47';
  
  console.log("Deleting transactions...");
  const { data: txns } = await supabase.from('transactions').select('transaction_id, uncategorized_transaction_id').eq('source', 'zoho_import');
  if (txns && txns.length > 0) {
    const txnIds = txns.map(t => t.transaction_id);
    const uncatIds = txns.map(t => t.uncategorized_transaction_id);
    
    await supabase.from('journal_entries').delete().in('transaction_id', txnIds);
    await supabase.from('transactions').delete().in('transaction_id', txnIds);
    await supabase.from('uncategorized_transactions').delete().in('uncategorized_transaction_id', uncatIds);
  }
  
  console.log("Resetting zoho_imports...");
  await supabase.from('zoho_imports').update({ processed: false }).eq('user_id', userId);
  
  console.log("Cleanup complete!");
}

cleanup();
