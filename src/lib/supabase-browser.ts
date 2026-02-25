'use client';

import { createClient } from '@supabase/supabase-js';

import { publicEnv } from './env';

const supabaseUrl = publicEnv('NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = publicEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

export const supabaseBrowser =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;
