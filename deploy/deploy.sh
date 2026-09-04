#!/usr/bin/env sh
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

if [ ! -f ".env.prod" ]; then
  echo "Missing .env.prod. Copy .env.prod.example to .env.prod and fill production values." >&2
  exit 1
fi

docker compose --env-file .env.prod -f "$COMPOSE_FILE" pull
docker compose --env-file .env.prod -f "$COMPOSE_FILE" up -d postgres
docker compose --env-file .env.prod -f "$COMPOSE_FILE" run --rm migrate

# Named volumes outlive one-shot containers. Use the existing backend service
# as a temporary root-owned initializer so this deploy script also remains
# compatible with older production Compose files that predate storage-init.
# The application itself still runs as the fixed non-root UID 10001.
docker compose --env-file .env.prod -f "$COMPOSE_FILE" run --rm --no-deps \
  --user 0:0 --entrypoint sh backend \
  -ec 'install -d -o 10001 -g 10001 -m 0700 /var/lib/igo-jobs /var/lib/igo-support
       chown -R 10001:10001 /var/lib/igo-jobs /var/lib/igo-support
       chmod 0700 /var/lib/igo-jobs /var/lib/igo-support'

if [ "${1:-}" = "--seed-admin" ]; then
  docker compose --env-file .env.prod -f "$COMPOSE_FILE" run --rm backend node dist/scripts/seed.js
fi

docker compose --env-file .env.prod -f "$COMPOSE_FILE" up -d

# nginx resolves the backend/frontend upstream IPs once at startup; when
# `up -d` recreates those containers they get new IPs and nginx serves 502s
# until it re-resolves. Restart it whenever it wasn't itself recreated.
docker compose --env-file .env.prod -f "$COMPOSE_FILE" restart nginx

docker compose --env-file .env.prod -f "$COMPOSE_FILE" ps
