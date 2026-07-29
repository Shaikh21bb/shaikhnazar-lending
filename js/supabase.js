const SUPABASE_URL = 'https://lvaluizbvqnvlxwvrmrm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xFQ7JM33hdgYRu_cD5QqrA_t9PB9Maw';

// Create a single supabase client for interacting with your database
window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
