# R7 — WebAdmin di atas Preline UI, Motion, dan Tailwind v4

Status: **selesai**. Alpine, Bootstrap, dan seluruh referensi CDN sudah tidak ada
di WebAdmin. Enam halaman panel berjalan di atas satu shell, satu bundle, dan
satu rangka tabel.

Dokumen ini menyatakan apa yang berubah, apa yang diukur, dan apa yang masih
menjadi risiko. Angka di sini hasil pengukuran terhadap staging pada 4 Agustus
2026, bukan perkiraan.

---

## 1. Cakupan

| Halaman | Sebelum | Sesudah |
|---|---|---|
| `dashboard.php` | shell lama | shell R7 |
| `settings.php` | Alpine | Preline + Motion |
| `users.php` | Alpine, render seluruh roster | rangka tabel, paginasi server |
| `channels.php` | Alpine, filter di browser | rangka tabel, paginasi server |
| `user_access.php` | Alpine, agregat tanpa paginasi | rangka tabel, dua query |
| `admin_panel.php` | Bootstrap + Font Awesome, layout sendiri | shell R7 |
| `login.php` | — | Preline (`hs-toggle-password`) |

Dihapus karena tidak dirujuk apa pun, dan di dalamnya seluruh sisa tag CDN:
`assign.php`, `layout.php`, `sidebar.php`, `create_admin.php`.

---

## 2. Komponen Preline

Peta lengkapnya — setiap komponen, URL dokumentasinya, apa yang digantikannya,
dan apa yang diubah supaya menjadi milik AM2 dan bukan milik Preline — ada di
[`docs/reference/preline-component-map.md`](../reference/preline-component-map.md).
Yang dicatat di sini hanya distribusi akhirnya.

Preline UI 4.2.0, MIT, hanya tier gratis. Empat plugin diimpor; tidak ada yang
lain, dan tes menurunkan daftar itu dari hook `hs-*` di markup lalu memeriksanya
dua arah.

| Plugin | Dipakai di | Untuk apa |
|---|---|---|
| `overlay` | users, channels, user_access, admin_panel, settings, shell | semua dialog, laci mobile, lembar detail |
| `dropdown` | `partials/shell.php` | menu header, menu akun |
| `accordion` | `partials/shell.php`, `shell_end.php` | grup navigasi yang bisa dilipat |
| `toggle-password` | login, users, admin_panel, settings | tombol lihat password |

Dua jebakan yang dijelaskan panjang di dokumen referensi itu, disebut di sini
supaya tidak terulang: `--ignore-annotations` **wajib** (tanpa itu esbuild
membuang setiap plugin Preline tanpa error, exit 0), dan Preline baru
menyembunyikan overlay setelah transisinya selesai — transisi pada properti yang
tidak pernah berubah menghasilkan overlay tak terlihat yang menelan setiap klik.

---

## 3. Peta motion

Motion 12.43.0. Durasi ada di `asset/js/src/am2-ui.js` (`T`), easing di `EASE`.

| Gerakan | Durasi | Easing | Di mana |
|---|---|---|---|
| hover, focus, checked | 140 ms | standard | seluruh kontrol, lewat CSS `--duration-micro` |
| dropdown, popover | 160 ms | enter | `open.hs.dropdown` |
| dialog, scrim | 180 ms | enter | `open.hs.overlay` |
| laci | 220 ms | enter | overlay ber-`data-am2-drawer` |
| keluar | 120 ms | exit | `close.hs.overlay` |

Scrim hanya memudar; panel bergerak. Backdrop yang ikut berpindah menarik mata
menjauh dari benda yang justru ingin diisolasinya.

`--duration-modal` sudah dihapus dari tema: Motion yang memegang waktu dialog,
dan satu-satunya pembaca token itu adalah atribut `x-transition` di halaman yang
kini sudah ditulis ulang.

`prefers-reduced-motion` mematikan dua animasi berulang di aplikasi ini
(`am2-live`, `am2-skeleton`), bukan sekadar memperlambatnya.

---

## 4. Rangka tabel bersama

Empat halaman roster memakai satu rangka: `partials/table_open.php`,
`partials/table_close.php`, dan runtime `asset/js/src/am2-table.js`. Halaman
menyediakan markup dan atribut data; tidak satu pun menulis JavaScript untuk
seleksi, keyboard, atau bulk.

Kontrak markup:

```
[data-am2-table]            pembungkus, data-total = baris yang cocok filter
tr[data-row-id]             satu baris
[data-select]               checkbox baris
[data-select-page]          checkbox header: halaman ini saja
[data-select-all-matching]  tawaran memperluas ke seluruh filter
[data-bulk-bar]             bar melayang
[data-bulk="<verb>"]        satu kata kerja
[data-row-result]           tempat hasil per baris ditulis
[data-toggle]               kontrol yang membalik satu field
```

Filter, urutan, dan halaman ada di query string (`?search=&chip=&sort=&dir=&p=`),
jadi sebuah tampilan bisa dikirim ke orang lain dan tombol back berperilaku
benar. Keyboard: `/` fokus ke pencarian, `j`/`k` pindah baris, `x` menandai,
`Esc` membatalkan pilihan. Shift memperluas dari baris terakhir yang disentuh.

Aturan yang membuat modul ini ada: **kontrol yang mengubah state menggambar
DOM-nya sendiri.** Yang digantikannya mengikat `:class` dan `x-text` ke
`$el.dataset`, yang tidak diamati Alpine — tulisan sampai ke database dan layar
tidak bergerak sampai halaman dimuat ulang.

---

## 5. Yang diukur

### Bobot halaman

Chrome headless, CPU dicekik 4×, median dari tiga kali muat, terhadap staging.

| Halaman | Elemen | DCL | Load |
|---|---:|---:|---:|
| `dashboard.php` | 429 | 250 ms | 260 ms |
| `admin_panel.php` | 662 | 141 ms | 153 ms |
| `channels.php` | 659 | 164 ms | 175 ms |
| `user_access.php` | 879 | 201 ms | 212 ms |
| `settings.php` | 559 | 187 ms | 203 ms |
| `users.php` | 1262 | 195 ms | 213 ms |

Perubahan yang paling besar pengaruhnya, keduanya soal jumlah baris yang
dikirim, bukan soal CSS:

- `users.php` merender seluruh 218 unit. Dengan paginasi sisi server: 4508 → 1262
  elemen, dan waktu muat 1536 ms → sekitar 200 ms.
- `channels.php` mengirim 219 checkbox unit untuk menampilkan 8 channel — daftar
  yang tidak dilihat siapa pun sampai dialog akses dibuka. Diambil saat dibuka:
  1748 → 659 elemen, 326 kB → 154 kB markup.
- `user_access.php` mengagregasi seluruh membership di database untuk
  menampilkan 20 baris; `LIMIT` berlaku setelah `GROUP BY`. Sekarang dua query.

### Aset

| Berkas | Ukuran |
|---|---:|
| `asset/js/am2-ui.min.js` | 204.6 kB |
| `asset/css/am2-tailwind.css` | 61.3 kB |
| `asset/css/am2-ui.css` | 37.9 kB |
| `asset/image/logo.jpeg` | 13.4 kB |

Bundle turun dari 273.7 kB setelah impor Preline dipangkas ke empat plugin yang
benar-benar dipakai markup; naik lagi ke 204.6 kB saat runtime tabel masuk.
Logo 89.3 → 13.4 kB. Alpine (dulu dimuat di setiap halaman) sudah tidak dikirim
sama sekali.

### Aksesibilitas

Diaudit di browser terhadap enam halaman: nama yang bisa diumumkan pada setiap
kontrol yang terlihat, label pada setiap input, `alt` pada setiap gambar, tidak
ada level heading yang dilompati, setiap dialog punya nama, `lang` pada `<html>`,
dan landmark `nav`/`main`.

**Enam halaman bersih.** Dua temuan diperbaiki saat mengukur, keduanya kesalahan
yang sama — placeholder bukan label:

- kotak pencarian di keempat halaman roster (`partials/table_open.php`)
- pemilih berkas APK di `settings.php`

Yang **tidak** dicakup audit ini: kontras warna. Itu perlu warna terkomputasi
dari teks terhadap apa pun yang ada di belakangnya, dan angka yang dikarang di
sini akan lebih buruk daripada mengakui celahnya.

### Tes

189 tes kontrak, 45 suite, semuanya hijau. Tumbuh dari 140 di awal R7.

Guard yang ditambahkan di R7 dan sudah dibuktikan bisa merah:

- tidak ada direktif Alpine di template mana pun, tidak ada gate di shell, tidak
  ada `alpine.min.js` yang dikirim
- tidak ada halaman yang memuat stylesheet atau script dari host lain
- tidak ada halaman yang menyebut Bootstrap atau Font Awesome
- plugin Preline yang dibutuhkan markup diturunkan dari hook `hs-*` di markup itu
  sendiri, lalu diperiksa dua arah terhadap impor bundle
- halaman tidak memanggil `AM2.*` sebelum ada yang menunggu bundle yang `defer`
- ukuran halaman roster (≤20 baris) dan plafon jumlah elemen

---

## 6. Cacat yang ditemukan dan diperbaiki

Bukan pekerjaan UI, tapi ditemukan saat mengerjakannya.

| Cacat | Akibat |
|---|---|
| `import_db` di `settings.php` tanpa cek role | admin cabang bisa menimpa database seluruh tenant |
| Restore melaporkan sukses tanpa syarat | `psql` keluar 0 walau setiap statement ditolak, dan hasilnya dibuang |
| Audit restore selalu gagal | FK `ptt_logs` → `users`/`channels`; restore yang berhasil dilaporkan gagal |
| `export_db` membocorkan seluruh tenant | `pg_dump -t` tidak punya WHERE |
| Unggah APK mustahil | batas PHP 2M/8M; di atas `post_max_size` PHP mengosongkan `$_POST`, jadi CSRF menjawab "sesi tidak valid" |
| Visibilitas channel pakai LEFT JOIN | satu baris per admin pengelola; salah begitu dihitung dan dipaginasi |
| `create_admin.php` | siapa pun yang login bisa membukanya, tanpa CSRF, menyisipkan role istimewa — ke tabel yang salah, jadi tidak pernah berfungsi |
| `role` dari POST tidak diwhitelist | akun dengan role yang tidak dikenali apa pun |
| Toggle terikat ke `$el.dataset` | database berubah, layar tidak |
| `toast()` hanya menerima Element | setiap `AM2.toast("pesan")` diam-diam tidak melakukan apa-apa |

---

## 7. Risiko yang tersisa

**Kredensial belum dirotasi.** Dua password root dan password database pernah
lewat percakapan di sesi-sesi sebelumnya. Tidak pernah dipakai dan tidak pernah
ditulis ke berkas mana pun, tapi tetap harus diganti.

**VPS lama `163.223.104.35` masih hidup** dengan salinan database lengkap.

**`app_versions` kosong di staging dan produksi**, jadi `/api/check-update`
menjawab 404 ke setiap radio. Tidak ada `update.apk` di direktori yang dilayani
relay, dan unggahan panel masuk ke direktori berbeda (jalur APK admin). Rantai
pembaruan otomatis belum tersambung ujung ke ujung.

**`AM2_API_AUTH_MODE=log`, bukan `enforce`,** di staging dan produksi. Kunci yang
salah atau tidak ada hanya dicatat, permintaannya tetap diteruskan — termasuk ke
`POST /api/admin/set-app-version`, satu-satunya penulis `app_versions`. Mode
`log` memang tahap wajar sebelum dikencangkan; kalau lognya sudah bersih, ini
tinggal mengganti satu nilai.

**`git filter-branch` di 4 Agustus** menghapus `docs/superpowers` dari riwayat
dua branch. GitHub masih menyimpan objek yang tak terjangkau di sisinya sampai
GC mereka sendiri, dan siapa pun yang sudah clone sebelum force-push masih
memegang salinannya.

**Kontras warna belum diukur.** Lihat bagian aksesibilitas.

**Unggahan untuk kanal APK lapangan belum diputuskan.** `settings.php` melayani
kanal admin; kanal lapangan belum punya antarmuka.

---

## 8. Cara menjalankan

```sh
# dari ~/am2-main di VPS pengembangan
cd WebAdmin && npm run build          # Tailwind + esbuild
rsync -a --exclude node_modules ~/am2-main/WebAdmin/ \
      /var/www/am2/staging/repo/WebAdmin/
cd ~/am2-main && node --test tests/contract/*.test.mjs
```

`rsync` tidak memakai `--delete`, jadi berkas yang dihapus dari repo akan
tertinggal di staging dan membuat tes yang membaca sumber gagal — hapus manual.
Jalankan `npm run build` setiap kali sebuah kelas Tailwind atau bundle berubah,
kalau tidak kelasnya terkirim tanpa aturan di belakangnya.
