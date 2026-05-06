import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  'https://fwvbjmntuersvhvqxuxq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3dmJqbW50dWVyc3ZodnF4dXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQyMTA5MjQsImV4cCI6MjA3OTc4NjkyNH0.GuNM7nSYMcPx6mWTywCVpOMF_tYlx1Y6iHYUk3LX4Hc'
);
