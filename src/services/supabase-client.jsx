import { createClient } from '@supabase/supabase-js';

// const supabaseUrl = 'https://gxwpvpqatisvkpgpstst.supabase.co';
const supabaseUrl = 'https://afbfotxelguficwfagnu.supabase.co';
const supabaseKey = '***REMOVED***'

export let supabase = createClient(supabaseUrl, supabaseKey);
