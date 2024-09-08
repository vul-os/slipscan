import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://wmpyolgckopmwhhlaiye.supabase.co';
const supabaseKey = '***REMOVED***';

export let supabase = createClient(supabaseUrl, supabaseKey);

export function createSupabaseClient(sessionToken) {
  const options = {};
  
  if (sessionToken) {
    options.global = {
      headers: {
        'x-customer-token': sessionToken,
      },
    };
  }

  supabase = createClient(supabaseUrl, supabaseKey, options);
  return supabase;
}