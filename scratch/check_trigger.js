const { supabase } = require('./backend/shared/supabase');

async function checkTrigger() {
  const { data, error } = await supabase.rpc('get_trigger_def', {});
  console.log(data || error);
}

checkTrigger();
