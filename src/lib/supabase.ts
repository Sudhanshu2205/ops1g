import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://uaiuhfbxdmlogpdmgtey.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_HfPGFruqFbK4D_aKl2xXQQ_wwDUXOS8';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
