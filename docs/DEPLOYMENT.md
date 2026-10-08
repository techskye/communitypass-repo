# Deploying CommunityPass to a single VPS

The stack runs these services under Docker Compose:

* `postgres`, `redis`
* `migrate` (one-off)
* `api`, `worker`, `web`
* `caddy` (automatic HTTPS) in production

## 1. Server preparation

* Ubuntu 24.04 LTS (or similar). At least 2 vCPU, 4 GB RAM and 40 GB SSD. Choose a region with
  good latency to Nigeria (e.g. Lagos or Johannesburg, or a European region).
* A DNS `A`/`AAAA` record for your domain pointing at the server.
* Firewall: allow 22 (SSH), 80 and 443 only.

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh          # Docker Engine + Compose plugin
sudo usermod -aG docker $USER && newgrp docker
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

## 2. Configure

```bash
git clone <your repo> && cd <repo>/communitypass
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

* `APP_MODE=live`. Keep `demo` for a staging/demo server.
* `WEB_BASE_URL=https://your.domain` and `DOMAIN=your.domain`.
* `POSTGRES_PASSWORD`: a long random value (`openssl rand -base64 32`).
* Paystack, WhatsApp and Resend credentials: see [INTEGRATION_NOTES.md](../INTEGRATION_NOTES.md).
  With `APP_MODE=live` the API and worker refuse to start if a required key is missing.

## 3. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
curl https://your.domain/api/health
```

* `migrate` runs `prisma migrate deploy` before `api` and `worker` start.
* Caddy gets TLS certificates automatically. It routes `/api/*` (including webhooks) straight
  to the API, so client IPs and raw webhook bodies are preserved. It routes everything else to
  the web app.
* The production overlay sets `COOKIE_SECURE=true` and `TRUST_PROXY=true`, and closes the host
  ports for api and web.

### Create the first platform admin

There is no public admin signup. Sign up as a normal user at `/creator/signup`, then promote
that account:

```bash
docker compose exec postgres psql -U communitypass -c \
  "UPDATE users SET \"isPlatformAdmin\" = true WHERE email = 'you@yourdomain.com';"
```

### Go-live checklist

1. Paystack webhook URL `https://your.domain/api/webhooks/paystack` is set (test and live).
2. Meta webhook callback `https://your.domain/api/webhooks/whatsapp` is verified and subscribed to `messages`.
3. WhatsApp templates are approved and recorded in **Admin → Integration health**.
4. The Resend domain is verified; a test magic-link email arrives.
5. For each creator: subaccount code, fee and fee bearer are recorded and the status is set to
   **Active** in **Admin → Organizations**.
6. Run a real low-value payment end to end. Check the **Payments** page and **Admin →
   Reconciliation**.
7. Legal pages have been reviewed and replaced.

## 4. Updating

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations run automatically through the `migrate` service. Take a backup first (below).

## 5. Backups

`deploy/backup.sh` writes a compressed `pg_dump` (custom format) and a tarball of the uploads
volume. It keeps the last 14 of each.

```bash
cd communitypass
./deploy/backup.sh /var/backups/communitypass
```

Nightly cron (02:30 Lagos time = 01:30 UTC):

```cron
30 1 * * * cd /home/deploy/app/communitypass && ./deploy/backup.sh /var/backups/communitypass >> /var/log/communitypass-backup.log 2>&1
```

**Copy backups off the server.** Sync `/var/backups/communitypass` to object storage (e.g.
`rclone sync` to an S3-compatible bucket with versioning). Encrypt them, because they contain
personal data. Redis holds only queue state and doesn't need backing up: due work is durable
in Postgres and the worker's sweepers re-queue it.

## 6. Restore

```bash
cd communitypass
./deploy/restore.sh /var/backups/communitypass/db-YYYYMMDDTHHMMSSZ.dump
# uploads (if needed):
docker run --rm -v communitypass_uploads:/data -v /var/backups/communitypass:/backup alpine:3 \
  sh -c "rm -rf /data/* && tar -xzf /backup/uploads-YYYYMMDDTHHMMSSZ.tar.gz -C /data"
```

`restore.sh`:

1. Asks you to type the database name.
2. Stops `api` and `worker`.
3. Recreates the database and restores the dump.
4. Re-runs migrations.
5. Restarts the services.

**Test restores regularly** on a staging server. The restore path was verified during
development by restoring a dump into a scratch database, including the integrity triggers.

After a restore:

* Pending orders are re-verified automatically by reconciliation.
* Notifications left in `SENDING` are flagged **Needs review**, not resent.
* Paystack retries webhooks that failed during downtime (reported as up to 72h in live mode).

## 7. Operations

* Logs: `docker compose logs -f api worker` (JSON, redacted).
* Health: `/api/health`; **Admin → Integration health** shows Redis, the last webhook per
  provider, 24h send and failure counts, and unprocessed events.
* Failed jobs and dead letters: **Admin → Failed jobs** (retry a queue job;
  failed/needs-review messages).
* Scale-out caveats: run **one** worker (maintenance jobs are idempotent but sized for one
  instance). Before adding API instances, move rate limiting to a Redis store.
