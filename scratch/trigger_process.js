require('dotenv').config({ path: 'C:/Users/SHREE/UV_PROJECT/LedgerAI/backend/.env' });
const supabase = require('../backend/config/supabaseClient');
const { runProcessor } = require('../backend/services/zohoProcessorService');

async function processData() {
  const userId = '7e6a3928-1ae7-4f1c-9cf1-cee0bee5af47';
  console.log("Triggering Zoho Processor...");
  const result = await runProcessor(userId, supabase);
  console.log("Processor Result:", result);
}

processData();
