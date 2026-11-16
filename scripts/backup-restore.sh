#!/bin/bash
# Backup/restore PostgreSQL databases for the Bazaarly stack.
# Usage:
#   MSYS_NO_PATHCONV=1 sh scripts/backup-restore.sh backup
#   MSYS_NO_PATHCONV=1 sh scripts/backup-restore.sh restore ./backups/<timestamp>
set -eu

COMPOSE_PROJECT="${COMPOSE_PROJECT:-bazaarly}"
PG_CONTAINER="$(docker ps --filter "name=postgres" --format '{{.Names}}' | head -n 1)"
PG_USER="${PGUSER:-postgres}"

if [ -z "$PG_CONTAINER" ]; then
  echo "error: postgres container not running (expected name *postgres*)" >&2
  exit 1
fi

DATABASES="bazaarly_identity bazaarly_catalog bazaarly_search bazaarly_inventory bazaarly_orders bazaarly_payments bazaarly_notifications bazaarly_fulfilment"

case "${1:-}" in
  backup)
    DEST="${2:-./backups/$(date +%Y%m%d-%H%M%S)}"
    mkdir -p "$DEST"
    echo "Backing up all Bazaarly databases from $PG_CONTAINER -> $DEST"
    for db in $DATABASES; do
      echo "  - $db"
      docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc --no-owner -d "$db" > "$DEST/${db}.dump"
    done
    echo "Backup complete: $DEST"
    ;;
  restore)
    SRC="${2:-}"
    [ -z "$SRC" ] && { echo "usage: $0 restore ./backups/<timestamp>" >&2; exit 1; }
    echo "Restoring Bazaarly databases from $SRC into $PG_CONTAINER"
    for archive in "$SRC"/*.dump; do
      db="$(basename "$archive" .dump)"
      echo "  - $db"
      docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" --no-owner --clean --if-exists -d "$db" < "$archive"
    done
    echo "Restore complete. Restart services to rebuild caches/outbox: docker compose restart"
    ;;
  *)
    echo "usage: $0 {backup [dest]|restore <src>}" >&2
    exit 1
    ;;
esac
