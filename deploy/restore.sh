#!/usr/bin/env sh
# Restores a PostgreSQL backup made by deploy/backup.sh.
# Usage: deploy/restore.sh backups/db-YYYYMMDDTHHMMSSZ.dump
# WARNING: replaces all data in the database. Stops api + worker during the restore.
set -eu
FILE="${1:?usage: deploy/restore.sh <backup.dump>}"
# Read only the variables we need (don't source .env: values may contain shell metacharacters).
envget() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2-; }
POSTGRES_USER="$(envget POSTGRES_USER)"
POSTGRES_DB="$(envget POSTGRES_DB)"
DB="${POSTGRES_DB:-communitypass}"
U="${POSTGRES_USER:-communitypass}"
printf "This will REPLACE all data in database '%s'. Type the database name to continue: " "$DB"
read -r CONFIRM
[ "$CONFIRM" = "$DB" ] || { echo "Aborted."; exit 1; }
docker compose stop api worker
docker compose exec -T postgres psql -U "$U" -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);"
docker compose exec -T postgres psql -U "$U" -d postgres -c "CREATE DATABASE \"$DB\" OWNER \"$U\";"
docker compose exec -T postgres pg_restore -U "$U" -d "$DB" --no-owner --exit-on-error < "$FILE"
docker compose run --rm migrate
docker compose start api worker
echo "Restore complete. Check /api/health and the admin integration-health page."
