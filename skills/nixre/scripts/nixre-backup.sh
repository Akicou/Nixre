#!/usr/bin/env bash
# nixre-backup.sh [outdir] — dump Postgres and tar the bare git repos.
#
#   ./nixre-backup.sh            # defaults to /var/tmp/nixre-backup-YYYYmmdd
#   ./nixre-backup.sh /mnt/backups
#
# The git repo volume lives at ./data/repos (mounted at /data/repos in core).
# Restore: pg_dump file -> `docker exec -i nixre-db psql -U nixre -d nixre < …`,
#          repos tar -> untar into /opt/nixre/data/.
set -euo pipefail

NIXRE_DIR="${NIXRE_DIR:-/opt/nixre}"
DB_USER="${DB_USER:-nixre}"
DB_NAME="${DB_NAME:-nixre}"
OUT="${1:-/var/tmp/nixre-backup-$(date '+%Y%m%d-%H%M%S')}"

mkdir -p "$OUT"
echo "Backing up to: $OUT"

cd "$NIXRE_DIR"

echo "[db] pg_dump nixre-db -> $OUT/nixre.dump"
docker exec nixre-db pg_dump -U "$DB_USER" "$DB_NAME" > "$OUT/nixre.dump"

echo "[git] tar repo volume -> $OUT/repos.tar.gz"
tar czf "$OUT/repos.tar.gz" -C "$NIXRE_DIR/data" repos

echo "[ssh keys] tar -> $OUT/ssh-keys.tar.gz (if present)"
# Keys live in ./data/ssh-keys when using the volume; harmless if absent.
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
