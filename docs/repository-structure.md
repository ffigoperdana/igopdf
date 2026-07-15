# Repository Structure

Struktur ini memisahkan kode aplikasi, dokumentasi, dan deployment tanpa mengubah entrypoint Vite multi-page.

```text
igopdf/
|- backend/                 API, autentikasi, RBAC, migrasi, dan report
|- deploy/                  deployment produksi dan template platform
|  `- templates/            template deployment opsional
|- docs/                    dokumentasi proyek
|  |- archive/              referensi historis yang tidak dipakai saat runtime
|  |- deployment/           release dan operasional deployment
|  |- development/          panduan kontribusi dan translation
|  |- internal/prompts/     konteks dan prompt historis untuk pengembangan
|  |- self-hosting/         panduan instalasi mandiri
|  `- tools/                dokumentasi fitur PDF
|- nginx/                   reverse proxy untuk stack Docker
|- public/                  aset statis dan berkas PWA
|- scripts/                 build, packaging, dan pemeriksaan proyek
|- src/                     TypeScript, CSS, partial, dan halaman fitur
|- vendor/                  paket lokal yang dikunci untuk build
|- *.html                   entrypoint Vite multi-page
|- docker-compose*.yml      stack pengembangan lokal
|- Dockerfile*              image frontend
|- package*.json            dependensi dan script frontend
`- vite.config.ts           konfigurasi build multi-page
```

## Root files

Entry HTML, Dockerfile, compose file, konfigurasi Vite/TypeScript, environment example, dan dokumen lisensi sengaja tetap di root. Memindahkannya memerlukan perubahan serentak pada Vite, nginx, Docker, dan workflow CI.

File hasil build dan pengujian seperti `dist/`, `tmp/`, log, coverage, serta environment lokal sudah dikecualikan melalui `.gitignore` dan tidak boleh masuk commit.

## Archived references

`docs/archive/igo-redesign-reference/` menyimpan mockup awal sebagai referensi visual. Folder ini tidak di-load oleh aplikasi dan tidak ikut menentukan perilaku runtime.

## Internal prompts

`docs/internal/prompts/` menyimpan konteks proyek historis yang sebelumnya ada di root. Dokumen ini bukan bagian dari aplikasi, build, atau deployment.
