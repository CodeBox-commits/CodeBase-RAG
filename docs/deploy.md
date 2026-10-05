# Deployment runbook

How the app is built, shipped, run, backed up and rolled back. Everything here is
rehearsed locally; hosting is chosen later (see "Going live").

## Pipeline at a glance

```
PR ──► CI (lint · types · unit · integration · frontend · docker · deploy-config · security)
          │ merge
main ──► CI ──(green)──► Release: image ghcr.io/codebox-commits/git-rag-project
                                   tags: sha-<short>, main      (needs PUSH_IMAGES=true)
tag v1.2.3 ────────────► Release: + tags 1.2.3, 1.2 and a GitHub Release with notes
```

- **Build once, deploy many:** the server never builds. It pulls an image that CI
  already tested.
- **Every image is immutable** and named after its commit (`sha-abc1234`).
  Deploying = running a tag; rolling back = running the previous tag.
- Image publishing is off until the repository variable `PUSH_IMAGES=true` is set
  (Settings → Secrets and variables → Actions → Variables). Private repos on the
  free plan only get 500 MB of package storage.

## Models and API keys

| What | Where it runs | Needs |
|---|---|---|
| Embeddings (default) | Local: FastEmbed `BAAI/bge-small-en-v1.5`, 384-d, baked into the image | Nothing: free, offline |
| Embeddings (optional) | Gemini `gemini-embedding-001`, 768-d (`EMBEDDING_PROVIDER=gemini`) | `GEMINI_API_KEY` |
| Reranker | Local: FlashRank MiniLM-L-12, baked into the image | Nothing |
| Answers (LLM) | Gemini `LLM_MODEL` | `GEMINI_API_KEY` |

- Indexing never calls an LLM, so with local embeddings it needs no API key at all.
- Each embedding model writes to its own Qdrant collection (`code_<model>_<dims>`):
  switching provider/model requires re-indexing, and vectors from different models
  can never be mixed.
- The image sets `HF_HUB_OFFLINE=1`: models are never downloaded at runtime.
- Memory: local embedding runs in small batches (`LOCAL_EMBED_BATCH_SIZE`, default
  16). A cold index of `pallets/click` (765 symbols) peaked at ~870 MiB in the worker.

## Health endpoints

| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /health` | Liveness: process is up. Never touches databases. | Container healthcheck, restarts |
| `GET /ready` | Readiness: Neo4j, Qdrant and Redis answer within 3s. `503` + the failing dependency otherwise. | Deploy smoke test, load balancers, you |

## Production stack (`deploy/docker-compose.prod.yml`)

| Service | Network | Notes |
|---|---|---|
| caddy | edge | Only service with host ports (80/443). Automatic HTTPS. |
| api | edge, internal, egress | FastAPI + UI, non-root, 1 GB cap |
| worker | internal, egress | Celery, concurrency 2, 1.5 GB cap |
| neo4j / qdrant / redis | internal only | No host ports, no internet. Redis requires a password. |

`internal` is a Docker network with `internal: true`: databases can talk to the app
but not to the internet, and nothing outside can reach them.

## First-time setup on a server

```bash
# on the server (Docker + Compose plugin installed), as a non-root deploy user
git clone https://github.com/CodeBox-commits/git-rag-project.git /opt/git-rag-project
cd /opt/git-rag-project
cp deploy/.env.example deploy/.env
# edit deploy/.env: DOMAIN, TAG, GEMINI_API_KEY, and strong passwords and MCP token:
openssl rand -hex 24
chmod 600 deploy/.env
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
curl -s https://$DOMAIN/ready
```

The MCP endpoint is `https://$DOMAIN/mcp`. It only answers requests for `$DOMAIN` and
requires `Authorization: Bearer $MCP_TOKEN` on every call.

Point the domain's DNS A record at the server first: Caddy needs it to get a
certificate. Open only ports 22, 80 and 443 in the firewall.

## Deploy a new version

```bash
cd /opt/git-rag-project
sed -i 's/^TAG=.*/TAG=sha-abc1234/' deploy/.env          # or 1.2.3
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env pull api worker
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d api worker
curl -s https://$DOMAIN/ready                              # must be "ready"
```

Only `api` and `worker` are replaced; databases keep running.

## Roll back

Same as deploying, with the previous tag. Find tags in the GitHub Packages page or
in a backup's `images.txt`. Images are immutable, so the old tag is exactly what ran
before.

If a release changed stored data in an incompatible way, restore the backup taken
before it (below), which also records the image that matches it.

## Backups

```bash
deploy/backup.sh                       # -> backups/<UTC timestamp>/
```

- **Cold and consistent:** stops api/worker, then the databases, archives the three
  volumes at the same moment, restarts everything (~1 min downtime). The three
  stores reference the same symbols, so they must be captured together.
- Writes `SHA256SUMS` and `images.txt` (what was running). Keeps the newest 7
  (`KEEP=14 deploy/backup.sh` to change).
- Nightly via cron:
  `0 3 * * * cd /opt/git-rag-project && deploy/backup.sh >> /var/log/gitrag-backup.log 2>&1`
- Copy backups off the server (another region, object storage). A backup on the same
  disk doesn't survive losing the disk.

Online (no-downtime) alternatives, for later: Neo4j Enterprise online backup, Qdrant
snapshots API, Redis `BGSAVE`. They need coordination to stay consistent across stores.

## Restore

```bash
deploy/restore.sh backups/20261002T030000Z     # asks you to type "restore"
```

Verifies checksums, stops the stack, replaces the three volumes, starts the stack and
prints the images that matched the backup.

**Drill (do it after every change to these scripts):** seed data → backup → delete the
volumes → restore → compare counts. Last run: identical counts in Neo4j, Qdrant and
Redis.

## Troubleshooting

| Symptom | Check |
|---|---|
| `/ready` is 503 | The JSON names the dependency: `docker compose ... logs <service>` |
| A container is `unhealthy` | `docker inspect -f '{{json .State.Health}}' <container>` shows the probe output |
| Neo4j won't start, "Unrecognized setting" | Any `NEO4J_*` env var becomes a config key; use another prefix |
| HTTPS certificate errors | DNS must point at the server and ports 80/443 must be open |
| Disk filling up | Logs are capped (3 × 10 MB per service); check `backups/` retention |

## Going live (Task 3b, after Phase 1)

Free options, in order of preference: Oracle Cloud Always Free ARM VM (images are
multi-arch), GitHub Student Pack credits (DigitalOcean/Azure), or this laptop plus a
Cloudflare Tunnel for demos. Then: a GitHub `production` environment with secrets
and required approval, and a deploy workflow that runs the "Deploy" steps above over
SSH with an automatic rollback when `/ready` fails.
