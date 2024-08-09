import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://mzqxrxrkiwmodnviosjf.supabase.co';
const supabaseKey = '***REMOVED***';

export const supabase = createClient(supabaseUrl, supabaseKey);
