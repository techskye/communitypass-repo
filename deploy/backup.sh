#!/usr/bin/env sh
# Creates a compressed, timestamped PostgreSQL backup (custom format) plus the uploads volume.
# Usage: deploy/backup.sh [backup-dir]   (run from the communitypass/ directory on the VPS)
set -eu
DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DIR"
# Read only the variables we need (don't source .env: values may contain shell metacharacters).
envget() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2-; }
POSTGRES_USER="$(envget POSTGRES_USER)"
POSTGRES_DB="$(envget POSTGRES_DB)"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-communitypass}" -d "${POSTGRES_DB:-communitypass}" \
  --format=custom --no-owner --compress=9 > "$DIR/db-$STAMP.dump"
# Uploads (community images) live in the "<project>_uploads" volume.
docker run --rm -v communitypass_uploads:/data:ro -v "$(cd "$DIR" && pwd)":/backup alpine:3 \
  tar -czf "/backup/uploads-$STAMP.tar.gz" -C /data . || echo "warning: uploads backup failed"
# Keep the last 14 backups of each kind.
ls -1t "$DIR"/db-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$DIR"/uploads-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "Backup written: $DIR/db-$STAMP.dump"
