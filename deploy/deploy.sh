#!/usr/bin/env sh
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

if [ ! -f ".env.prod" ]; then
  echo "Missing .env.prod. Copy .env.prod.example to .env.prod and fill production values." >&2
  exit 1
fi

docker compose --env-file .env.prod -f "$COMPOSE_FILE" pull
docker compose --env-file .env.prod -f "$COMPOSE_FILE" up -d postgres
docker compose --env-file .env.prod -f "$COMPOSE_FILE" run --rm backend node dist/scripts/migrate.js

if [ "${1:-}" = "--seed-admin" ]; then
  docker compose --env-file .env.prod -f "$COMPOSE_FILE" run --rm backend node dist/scripts/seed.js
fi

docker compose --env-file .env.prod -f "$COMPOSE_FILE" up -d
docker compose --env-file .env.prod -f "$COMPOSE_FILE" ps
