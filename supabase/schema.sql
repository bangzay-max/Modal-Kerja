-- Jalankan ini di Supabase Dashboard > SQL Editor (project kvowqsyvpzgqrbuahhdk),
-- sekali saja saat setup awal.

create table if not exists public.mk_storage (
  key text primary key,
  value text not null,
  shared boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.mk_storage enable row level security;

-- PENTING (baca sebelum lanjut ke produksi beneran):
-- Policy di bawah ini bikin siapa pun yang pegang anon/publishable key bisa
-- baca & tulis SEMUA baris di tabel ini — cocok buat prototipe tanpa sistem
-- login. Kalau nanti app ini dipakai beneran oleh banyak admin cluster dan
-- datanya sensitif, ganti jadi Supabase Auth + policy yang membatasi tiap
-- admin cuma bisa akses baris milik cluster-nya sendiri.
create policy "prototype: anon can read/write mk_storage"
  on public.mk_storage
  for all
  to anon
  using (true)
  with check (true);

create index if not exists mk_storage_key_prefix_idx on public.mk_storage (key text_pattern_ops);
