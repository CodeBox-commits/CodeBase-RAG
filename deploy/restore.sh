#!/usr/bin/env bash
# Restore all three data stores from a backup made by backup.sh.
#   deploy/restore.sh backups/20261002T030000Z
# Replaces the current data. The stack is stopped while volumes are rewritten.
set -euo pipefail

src=${1:?usage: deploy/restore.sh <backup-dir>}
COMPOSE_FILE=${COMPOSE_FILE:-deploy/docker-compose.prod.yml}
ENV_FILE=${ENV_FILE:-deploy/.env}
PROJECT=gitrag-prod
VOLUMES=(neo4j_data qdrant_data redis_data)

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

echo "[restore] verifying checksums in $src"
docker run --rm -v "$(cd "$src" && pwd):/backup:ro" -w /backup alpine:3 sha256sum -c SHA256SUMS

if [[ "${FORCE:-}" != "1" ]]; then
  read -r -p "This replaces ALL current data with $src. Type 'restore' to continue: " answer
  [[ "$answer" == "restore" ]] || { echo "aborted"; exit 1; }
fi

echo "[restore] stopping stack"
compose stop

for vol in "${VOLUMES[@]}"; do
  echo "[restore] restoring $vol"
  # Compose's own labels, so it adopts a recreated volume without warnings.
  docker volume create \
    --label "com.docker.compose.project=${PROJECT}" \
    --label "com.docker.compose.volume=${vol}" \
    "${PROJECT}_${vol}" >/dev/null
  docker run --rm \
    -v "${PROJECT}_${vol}:/target" \
    -v "$(cd "$src" && pwd):/backup:ro" \
    alpine:3 sh -c "find /target -mindepth 1 -delete && tar -xzf /backup/${vol}.tar.gz -C /target"
done

echo "[restore] starting stack"
compose up -d
echo "[restore] done. Images running at backup time:"
cat "$src/images.txt"
