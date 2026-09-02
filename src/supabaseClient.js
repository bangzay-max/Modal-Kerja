import { createClient } from "@supabase/supabase-js";

// Anon/publishable key sengaja aman dipakai di sisi client — proteksi datanya
// ada di Row Level Security (RLS) policy di sisi Supabase, bukan di key ini.
// Nilai default di bawah dipakai kalau env var belum di-set (biar langsung
// jalan). Untuk produksi tetap lebih rapi pakai env var (lihat .env.example
// dan README.md bagian Supabase).
const FALLBACK_URL = "https://kvowqsyvpzgqrbuahhdk.supabase.co";
const FALLBACK_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2b3dxc3l2cHpncXJidWFoaGRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMjc2NDAsImV4cCI6MjEwMzkwMzY0MH0.KrpE95I0lYHFzzZXij2bdBuqOkNlIbJL3VbuBzVE76o";

const url = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_ANON_KEY;

export const supabase = createClient(url, anonKey);
