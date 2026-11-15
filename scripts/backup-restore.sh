#!/bin/sh
# V-11: Backup and restore MongoDB databases for the Bazaarly stack.
# Usage:
#   sh scripts/backup-restore.sh backup              # writes ./backups/<timestamp>/
#   sh scripts/backup-restore.sh restore ./backups/<timestamp>
set -eu

COMPOSE_PROJECT="${COMPOSE_PROJECT:-bazaarly}"
MONGO_CONTAINER="$(docker ps --filter "name=mongo" --format '{{.Names}}' | head -n 1)"

if [ -z "$MONGO_CONTAINER" ]; then
  echo "error: mongo container not running (expected name *mongo*)" >&2
  exit 1
fi

case "${1:-}" in
  backup)
    DEST="${2:-./backups/$(date +%Y%m%d-%H%M%S)}"
    mkdir -p "$DEST"
    echo "Backing up all Bazaarly databases from $MONGO_CONTAINER -> $DEST"
    for db in identity catalog search inventory orders payments notifications fulfilment; do
      echo "  - $db"
      docker exec "$MONGO_CONTAINER" mongodump --db "$db" --archive="/tmp/${db}.archive" >/dev/null
      docker cp "$MONGO_CONTAINER:/tmp/${db}.archive" "$DEST/${db}.archive"
      docker exec "$MONGO_CONTAINER" rm -f "/tmp/${db}.archive"
    done
    echo "Backup complete: $DEST"
    ;;
  restore)
    SRC="${2:-}"
    [ -z "$SRC" ] && { echo "usage: $0 restore ./backups/<timestamp>" >&2; exit 1; }
    echo "Restoring Bazaarly databases from $SRC into $MONGO_CONTAINER"
    for archive in "$SRC"/*.archive; do
      db="$(basename "$archive" .archive)"
      echo "  - $db"
      docker cp "$archive" "$MONGO_CONTAINER:/tmp/${db}.archive"
      docker exec "$MONGO_CONTAINER" mongorestore --drop --db "$db" --archive="/tmp/${db}.archive" >/dev/null
      docker exec "$MONGO_CONTAINER" rm -f "/tmp/${db}.archive"
    done
    echo "Restore complete. Restart services to rebuild caches: docker compose restart"
    ;;
  *)
    echo "usage: $0 {backup [dest]|restore <src>}" >&2
    exit 1
    ;;
esac
