---
title: Large PDF Compression
description: Deploy and operate resumable server-side compression for PDFs above 100 MB.
---

# Large PDF Compression

IGO compresses PDFs up to 100 MB in the browser. Larger files use a private,
resumable server queue so that browser memory and unstable long-running uploads
do not interrupt the job.

## Request Flow

1. The browser reserves one queue slot for the signed-in user.
2. Only the first slot may upload. Later users see their queue position and do
   not send file data yet.
3. The browser uploads the PDF using TUS in sequential 25 MiB requests.
4. The backend validates the declared size, available disk space, and PDF
   header before creating the compression job.
5. A single worker processes one job at a time.
6. The result is removed after download, cancellation, or expiry.

The Nginx 32 MiB body limit is intentionally a **per-request** limit. It accepts
the 25 MiB chunks while still rejecting an accidental oversized request. It is
not the maximum PDF size.

## Production Settings

Set these values in `deploy/.env.prod` before running `./deploy.sh`:

```dotenv
SERVER_COMPRESSION_ENABLED=true
CLIENT_COMPRESSION_MAX_BYTES=104857600
SERVER_BALANCED_MAX_BYTES=524288000
SERVER_COMPRESSION_MAX_BYTES=1073741824
COMPRESSION_UPLOAD_CHUNK_BYTES=26214400
COMPRESSION_UPLOAD_IDLE_TIMEOUT_MS=1800000
COMPRESSION_UPLOAD_MAX_AGE_MS=10800000
COMPRESSION_DISK_HEADROOM_MULTIPLIER=3
COMPRESSION_DISK_MINIMUM_FREE_BYTES=1073741824
COMPRESSION_JOB_TIMEOUT_MS=2700000
COMPRESSION_RETENTION_MS=900000
COMPRESSION_WORKER_POLL_MS=2000
```

Files above 500 MB are restricted to Lossless mode. Files above 1 GB are
rejected before upload. The bundled production Compose file limits the worker
to one process and 4 GB RAM, which is appropriate for the current 2 vCPU / 6 GB
VM layout.

## Reverse Proxy And WAF

Allow authenticated requests to these paths and methods:

| Path                            | Methods                              | Purpose                            |
| ------------------------------- | ------------------------------------ | ---------------------------------- |
| `/api/compression/upload-slots` | `GET`, `POST`, `DELETE`              | Queue reservation and cancellation |
| `/api/compression/uploads`      | `POST`, `OPTIONS`                    | Create resumable upload            |
| `/api/compression/uploads/*`    | `HEAD`, `PATCH`, `DELETE`, `OPTIONS` | Resume, send chunks, or cancel     |
| `/api/compression/jobs/*`       | `GET`, `DELETE`                      | Poll, download, or cancel a job    |

The WAF must permit the `Upload-Length`, `Upload-Offset`, `Upload-Metadata`,
`Tus-Resumable`, and `Content-Type: application/offset+octet-stream` headers.
Each upload request is at most 25 MiB, so changing the Cloudflare upload limit
or switching the DNS record to DNS-only is not normally required. Use DNS-only
only as a temporary diagnostic if the WAF cannot be configured to pass TUS
`PATCH` and `HEAD` requests.

## Deployment Verification

From the production `deploy` directory:

```sh
./deploy.sh

docker compose --env-file .env.prod -f docker-compose.prod.yml ps

docker compose --env-file .env.prod -f docker-compose.prod.yml exec backend \
  node -e "import('./dist/config/index.js').then(({config}) => console.log(config.compression))"

docker compose --env-file .env.prod -f docker-compose.prod.yml exec nginx \
  nginx -T 2>&1 | grep -E \
  'client_max_body_size|client_body_timeout|proxy_request_buffering|proxy_read_timeout'
```

Expected services are `frontend`, `backend`, `postgres`, `nginx`, and
`pdf-worker`. Compression must report `enabled: true` and Nginx must report a
32 MiB body limit for the upload route.

## Monitoring

Watch the request path while reproducing an upload issue:

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  logs -f --timestamps nginx backend pdf-worker
```

Inspect queue and job state:

```sh
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT id, user_id, status, input_bytes, last_activity_at FROM compression_upload_slots ORDER BY created_at;"

docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT id, mode, status, error_code, input_bytes, created_at FROM compression_jobs ORDER BY created_at DESC LIMIT 20;"
```

If a public-network upload fails but the same upload works over the office VPN,
compare the Nginx/backend logs. No matching backend request means the failure
is in the upstream WAF or network path, not in the worker queue.

## Privacy And Cleanup

Temporary input, output, and TUS metadata live only in the private
`pdf_jobs` Docker volume. The application deletes them after download,
cancellation, idle expiry, or retention expiry. Do not mount that volume into
the frontend or expose it through Nginx.
