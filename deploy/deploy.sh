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

if [ "${1:-}" = "--seed-admin" ]; then
  docker compose --env-file .env.prod -f "$COMPOSE_FILE" run --rm backend node dist/scripts/seed.js
fi

docker compose --env-file .env.prod -f "$COMPOSE_FILE" up -d

# nginx resolves the backend/frontend upstream IPs once at startup; when
# `up -d` recreates those containers they get new IPs and nginx serves 502s
# until it re-resolves. Restart it whenever it wasn't itself recreated.
docker compose --env-file .env.prod -f "$COMPOSE_FILE" restart nginx

docker compose --env-file .env.prod -f "$COMPOSE_FILE" ps
