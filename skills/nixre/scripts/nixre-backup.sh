#!/usr/bin/env bash
# nixre-backup.sh [outdir] — dump Postgres and tar the bare git repos.
#
#   ./nixre-backup.sh            # defaults to ./backup-YYYYmmdd-HHMMSS
#   ./nixre-backup.sh /mnt/backups
#
# The git repo volume lives at <dir>/data/repos (mounted at /data/repos in core).
# Restore: pg_dump file -> `docker exec -i nixre-db psql -U "$DB_USER" -d "$DB_NAME" < …`,
#          repos tar -> untar into <dir>/data/.
#
# DB_USER / DB_NAME / NIXRE_DIR are read from the environment and default to
# the values in .env. They are NOT hard-coded: POSTGRES_PASSWORD is required
# now, so an install may well use different credentials.
set -euo pipefail

NIXRE_DIR="${NIXRE_DIR:-$(pwd)}"
# Fall back to .env when the operator has not exported them, so the script
# keeps working on an install with custom Postgres credentials.
if [ -z "${DB_USER:-}" ] && [ -f "$NIXRE_DIR/.env" ]; then
  DB_USER="$(sed -n 's/^POSTGRES_USER=\(.*\)$/\1/p' "$NIXRE_DIR/.env" | tail -n1)"
fi
if [ -z "${DB_NAME:-}" ] && [ -f "$NIXRE_DIR/.env" ]; then
  DB_NAME="$(sed -n 's/^POSTGRES_DB=\(.*\)$/\1/p' "$NIXRE_DIR/.env" | tail -n1)"
fi
DB_USER="${DB_USER:-nixre}"
DB_NAME="${DB_NAME:-nixre}"
OUT="${1:-backup-$(date '+%Y%m%d-%H%M%S')}"

mkdir -p "$OUT"
echo "Backing up to: $OUT"

cd "$NIXRE_DIR"

echo "[db] pg_dump nixre-db -> $OUT/nixre.dump"
docker exec nixre-db pg_dump -U "$DB_USER" "$DB_NAME" > "$OUT/nixre.dump"

echo "[git] tar repo volume -> $OUT/repos.tar.gz"
tar czf "$OUT/repos.tar.gz" -C "$NIXRE_DIR/data" repos

echo "[ssh keys] tar -> $OUT/ssh-keys.tar.gz (if present)"
if [ -d "$NIXRE_DIR/data/ssh-keys" ]; then
  tar czf "$OUT/ssh-keys.tar.gz" -C "$NIXRE_DIR/data" ssh-keys
fi

echo
echo "Done. Files:"
ls -lh "$OUT"
echo
echo "Restore:"
echo "  docker exec -i nixre-db psql -U $DB_USER -d $DB_NAME < $OUT/nixre.dump"
echo "  tar xzf $OUT/repos.tar.gz -C $NIXRE_DIR/data/"
