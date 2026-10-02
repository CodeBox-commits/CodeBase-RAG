#!/usr/bin/env bash
# Cold, consistent backup of all three data stores.
#
# Writers (api, worker) and databases are stopped while the volumes are archived, so
# Neo4j, Qdrant and Redis are captured at the same moment and agree with each other.
# Expect ~1 minute of downtime. Run from the repo root, e.g. nightly via cron:
#   0 3 * * * cd /opt/git-rag-project && deploy/backup.sh >> /var/log/gitrag-backup.log 2>&1
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-deploy/docker-compose.prod.yml}
ENV_FILE=${ENV_FILE:-deploy/.env}
BACKUP_ROOT=${BACKUP_ROOT:-backups}
KEEP=${KEEP:-7} # number of backups to keep
PROJECT=gitrag-prod
VOLUMES=(neo4j_data qdrant_data redis_data)

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$BACKUP_ROOT/$stamp"
mkdir -p "$dest"

# Always bring the stack back, even if archiving fails halfway.
trap 'echo "[backup] restarting services"; compose up -d >/dev/null' EXIT

echo "[backup] stopping writers, then databases"
compose stop api worker
compose stop neo4j qdrant redis

for vol in "${VOLUMES[@]}"; do
  echo "[backup] archiving $vol"
  docker run --rm \
    -v "${PROJECT}_${vol}:/source:ro" \
    -v "$(cd "$dest" && pwd):/backup" \
    alpine:3 tar -czf "/backup/${vol}.tar.gz" -C /source .
done

# Record what was running, so a restore can also roll the app back to match.
compose config --images > "$dest/images.txt"
# Checksums computed in a container so the script behaves the same on Linux and macOS.
docker run --rm -v "$(cd "$dest" && pwd):/backup" -w /backup alpine:3 sh -c 'sha256sum ./*.tar.gz > SHA256SUMS'

echo "[backup] done: $dest ($(du -sh "$dest" | cut -f1))"

# Retention: keep the newest $KEEP backups.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "[backup] pruning $old"
  rm -rf "$old"
done
