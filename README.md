# Modal Kerja — EJ Makassar Greater (prototipe)

Prototipe web app monitoring modal kerja harian. Upload beberapa file sumber
(Order Log, Mutasi Bank, Xendit), lalu otomatis jadi dashboard Summary MK dan
Modal Kerja.

## Setup database (Supabase) — wajib sebelum jalan

1. Buka project Supabase kamu (`kvowqsyvpzgqrbuahhdk`) → **SQL Editor**.
2. Copy-paste isi `supabase/schema.sql`, lalu **Run**. Ini bikin tabel
   `mk_storage` beserta kebijakan akses (RLS).
3. Env var Supabase sudah ada default-nya di `src/supabaseClient.js` (anon
   key aman dipakai di client — proteksinya ada di RLS policy, bukan di
   key). Kalau mau override, isi `.env` (contoh di `.env.example`) dan
   tambahkan variabel yang sama di **Vercel → Project Settings →
   Environment Variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

## Jalankan lokal

```bash
npm install
npm run dev
```

## Deploy ke Vercel via GitHub

1. Push folder ini ke repo GitHub baru.
   ```bash
   git init
   git add .
   git commit -m "init modal kerja app"
   git branch -M main
   git remote add origin <url-repo-github-kamu>
   git push -u origin main
   ```
2. Buka [vercel.com](https://vercel.com) → **Add New Project** → import repo
   GitHub tadi.
3. Vercel otomatis deteksi framework Vite (`vercel.json` sudah disiapkan).
   Build command `npm run build`, output `dist`. Klik **Deploy**.
4. Selesai — tiap push ke `main` otomatis deploy ulang.

## Batas versi ini (penting sebelum dipakai serius)

- **Data tersimpan di Supabase** (tabel `mk_storage`, key-value per
  cluster+bulan) — sudah sinkron lintas perangkat/browser, bukan lagi
  localStorage lokal.
- **Belum ada sistem login.** Policy RLS di `supabase/schema.sql` sengaja
  dibuka (anon boleh baca/tulis semua baris) supaya prototipe langsung
  jalan tanpa autentikasi. Ini artinya siapa pun yang tahu URL app bisa
  ubah data siapa pun. Sebelum dipakai serius oleh banyak admin cluster,
  tambahkan Supabase Auth (login per admin) + ganti policy jadi
  membatasi akses per cluster.
- Parser file (Order Log, Mutasi Bank, Xendit) mengasumsikan header kolom
  CSV persis sama seperti file sumber asli — lihat hint di tiap kartu upload
  pada tab "Unggah Data".
- Saldo akhir per bank/hari diambil dari baris terakhir tanggal tsb di file
  (asumsi urutan kronologis sesuai urutan baris di file export).
- Field Logical, Fisik, Product Attack, Eload, Stock WG, dan rincian
  Selisih Kurang/Lebih masih input manual — belum ada sumber file otomatis
  untuk itu.
