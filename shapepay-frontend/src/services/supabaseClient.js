import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://zkimqgkcwxaeyibtjwnt.supabase.co';
const supabaseKey = '***REMOVED***';

export const supabase = createClient(supabaseUrl, supabaseKey);
