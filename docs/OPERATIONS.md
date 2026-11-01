# Running the house (PLT-8)

## Start

```bash
pnpm env:init
```

```bash
docker compose up -d
```

`pnpm env:init` writes every secret at random into `.env` and `.secrets/` (both git-ignored); nothing
secret has a default in the repo, and `docker compose up` refuses to start without them. It starts
Postgres (one database per domain plus DBOS), SeaweedFS object storage, the practice supermarket, the
sealed shopping helper and the app, as the **practice household**.

For the real house run `pnpm env:init --real`, then fill in the credentials in `.env` (see
`.env.example`), and put the Waitrose login in `.secrets/waitrose.json` (JSON `{url, username, password}`)
owned by uid 1001 with mode 600. The helper refuses a login file anyone else can read (AUT-2), and the
app refuses to start in real mode while any secret is still a practice default (PRV-6).

Hindsight (episodic memory, PLT-6) is the optional `memory` profile: `docker compose --profile memory up -d`
and `HINDSIGHT_URL=http://hindsight:8888`. Without it the app keeps episodic memory in-process.

## Bring Family Lists over (once)

Shopping and simple lists live in the app (CAP-6). To copy the lists from Family Lists' Supabase
(lists and items, keeping their order, ticks and emoji), run it once on the server, inside the app's
container so it reads the house's own settings, after the app has started at least once:

```bash
export FAMILY_LISTS_DATABASE_URL='postgresql://…'   # in this shell only
docker compose run --rm -e FAMILY_LISTS_DATABASE_URL app node scripts/import-family-lists.ts --dry-run   # only counts
docker compose run --rm -e FAMILY_LISTS_DATABASE_URL app node scripts/import-family-lists.ts             # copies it
unset FAMILY_LISTS_DATABASE_URL
```

It prints the database prefix it copied into. Run anywhere without the house's settings it would
aim at the practice household, so it refuses; `--practice` copies into the practice household on
purpose.

| Variable | What it is |
| --- | --- |
| `FAMILY_LISTS_DATABASE_URL` | Family Lists' Postgres connection string (Supabase dashboard → Connect; add `?sslmode=require`). A role that can only `SELECT` on `lists` and `items` is enough. |
| `DATABASE_URL`, `DB_PREFIX`, `PRACTICE` and the rest of `.env` | Where to copy to: the app container already has them, exactly as the server reads them. |

Set the connection string in the shell for that one command; never put it in `.env`, the repo or a
chat. The script reads Family Lists in a read-only transaction and never writes to it, prints only
counts, and refuses to run if the house already has any list, so it cannot copy twice.

## Back up and restore

```bash
scripts/backup.sh
```

```bash
scripts/restore.sh backups/<timestamp>
```

A backup is every Postgres database (`pg_dumpall`) plus the object store's volume (already encrypted
client-side with `STORAGE_KEY` — keep that key somewhere else, e.g. the password manager), with SHA-256 sums.

### Tried once — 31 October 2026

On the build sandbox, against the full compose stack:

1. Priya captured "we need to clear the loft before christmas" and asked for bananas; the helper added
   them and stored three encrypted screenshots in SeaweedFS (no PNG header appears in the raw volume files).
2. `scripts/backup.sh` → `backups/20261031T212300Z` (postgres.sql 285 KB, objects.tgz 71 KB).
3. `docker compose down -v` — every volume deleted.
4. `scripts/restore.sh backups/20261031T212300Z`, then logged in again: the loft item was on the Backlog
   and the run's first screenshot decrypted to a PNG through `/api/objects/…`.

## The real house on the VPS

The real house runs on Cal's Hetzner VPS (2 vCPU, 3.7 GiB) next to the trader app, `hindsight` and
`docker-ib-gateway-1`, as its own compose project, `household`, from `deploy/`:

| Container | Memory cap (swap capped too) | Reachable from |
| --- | --- | --- |
| `caddy` (HTTPS for `HOUSEHOLD_DOMAIN`, certificates automatic) | 40 MB | the internet, ports 80 and 443 only |
| `app` | 288 MB | Caddy |
| `postgres` (tuned small) | 96 MB | the app |
| `objects` (SeaweedFS) | 128 MB | the app |

The caps are in one place, `x-memory` at the top of `deploy/compose.yml` (552 MB in all), so the house
can never push the trading containers into swap or out of memory. Nothing else is published: Postgres,
SeaweedFS and the app have no host ports. The server never builds anything; CI builds the image and
pushes it to GHCR.

- **Shopping helper:** not on the VPS (Waitrose blocks data-centre addresses); it will run at home. Until
  then each shopping request is recorded and fails at once, showing that nothing was added (nothing
  retries it later), and the app says
  `shopping (no helper: nothing is added)` at start.
- **Hindsight:** the existing instance, not a second copy. It publishes only on the host's 127.0.0.1:8888,
  which no container can reach, so the app joins Hindsight's own Docker network and calls
  `http://hindsight:8888`. `deploy/install.sh` finds that network (`docker inspect hindsight`) and writes
  `HINDSIGHT_NETWORK` to `/srv/household/.env`; `household-deploy` then adds `deploy/compose.hindsight.yml`.
  The house's memories are in their own banks, `household-home-person-<person>`, and it never reads another.
  If Hindsight is on Docker's default `bridge` network (no names there), give it a named one, preferably
  in Hindsight's own compose file so it survives a recreate: `docker network create hindsight-net &&
  docker network connect hindsight-net hindsight`, then add `HINDSIGHT_NETWORK=hindsight-net` to
  `/srv/household/.env` and redeploy. `HINDSIGHT_URL` in the same file overrides the address.
- **Deploys:** `.github/workflows/deploy.yml` runs after CI passes on a push to `main` (or by hand from
  Actions → deploy → Run workflow, on `main`). It builds and pushes the image, then runs
  `ssh household@<server> sha256:<digest>`. The `household` user has no password and is not in the
  docker group. Its only key is forced to `sudo -n /usr/local/sbin/household-deploy "$SSH_ORIGINAL_COMMAND"`,
  and one sudoers rule lets it run exactly that file. The file deploys an image by digest and nothing
  else. The compose file, Caddyfile and commands are the ones `install.sh` put on the server, so a push
  to `main` can change what runs inside the containers but not how they run. If the image's `deploy/`
  files differ, the deploy says so; re-run `install.sh` to take them. A deploy that doesn't come up
  healthy rolls back to the previous image. Before then nothing in the databases changes: the setup
  check reads only, and migrations run only when the new app starts. A rollback doesn't undo migrations
  the new app already ran. If the old image can't run on the newer schema, restore last night's backup
  (below) or deploy a fix.
- **Secrets:** generated on the server into `/srv/household/.env` (root only, mode 600) by
  `pnpm env:init --real`, run by `install.sh`. GitHub holds only the SSH key, host and known_hosts. The
  job passes its own short-lived token on stdin so the server can pull a private image; the server
  removes it straight after the pull.

### Cal's one-time steps, in order

**1. DNS.** Add an A record pointing the domain at the VPS's IPv4 address (and an AAAA record if it has
IPv6), e.g. `house.example.com. A 203.0.113.10`. Wait until `dig +short house.example.com` answers with
that address. Caddy needs it to get the certificate. If the server runs a firewall, allow 80/tcp,
443/tcp and 443/udp (`sudo ufw allow 80/tcp && sudo ufw allow 443`).

**2. The `household` user and its restricted command.** On your laptop, make the deploy key (no
passphrase; it can only deploy):

```bash
ssh-keygen -t ed25519 -N '' -C household-deploy -f household-deploy
```

On the server, from a checkout of this repo (any path; `git pull` it later to update `deploy/`):

```bash
git clone https://github.com/CalNicklin/household.git ~/household && cd ~/household
sudo deploy/install.sh --domain house.example.com --deploy-key "$(cat household-deploy.pub)"   # paste the .pub line
```

It installs `/srv/household` (compose file, Caddyfile, `.env` with every secret generated there), the
`household-deploy`, `household-setup`, `household-backup` and `household-restore` commands, the
`household` user with its forced command and sudoers rule (`/etc/sudoers.d/household-deploy`), and the
nightly backup timer. Running it again is safe: it keeps the secrets and changes only what you pass.
Check what it found: `sudo grep -E '^(HOUSEHOLD_DOMAIN|HINDSIGHT_NETWORK)=' /srv/household/.env`.
Copy `/srv/household/.env` into the password manager once. It holds `STORAGE_KEY`, without which the
object backups can't be read.

**3. The GitHub secrets** (Settings → Secrets and variables → Actions, or with `gh`):

```bash
gh secret set HOUSEHOLD_SSH_KEY < household-deploy                     # the private key
gh secret set HOUSEHOLD_SSH_HOST --body "203.0.113.10"                 # the server's address
ssh-keyscan -t ed25519 203.0.113.10 | gh secret set HOUSEHOLD_SSH_KNOWN_HOSTS
```

Check the scanned key against the server's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on
the server, `ssh-keygen -lf <(ssh-keyscan -t ed25519 203.0.113.10)` locally), then delete the private key
from the laptop. Until all three secrets exist, the deploy workflow skips with a notice.

**4. The first deploy.** Actions → deploy → Run workflow (on `main`), or merge anything to `main`. The first
deploy pulls the image, starts Postgres and SeaweedFS, and stops with "The house is not set up yet". Then,
on the server, describe the house (no secrets in it):

```json
{
  "name": "Home",
  "timezone": "Europe/London",
  "latitude": 51.45,
  "longitude": -2.59,
  "adults": [
    { "id": "cal", "name": "Cal", "email": "cal@example.com", "telegram": "123456789" },
    { "id": "chloe", "name": "Chloe", "email": "chloe@example.com" }
  ],
  "children": [{ "id": "kid", "name": "Kid", "nurseryDays": ["mon", "tue"] }],
  "healthOwner": "chloe"
}
```

```bash
sudo household-setup < house.json
```

`healthOwner` is the one adult whose health tracking may exist (PRV-2). Leave it out and nobody's does.
It prints each adult's app login once (username and a generated password): put them in the password
manager. Then fill in the credentials `.env` still lacks (`sudo nano /srv/household/.env`:
`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, the Google settings; see `.env.example`). The Google token file
goes where only the app can read it, and `.env` names it by its path inside the container:

```bash
sudo install -o 10001 -m 400 google.json /srv/household/credentials/google.json
# in /srv/household/.env:
GOOGLE_ACCESS_TOKEN_FILE=/run/household-credentials/google.json
```
 Redeploy what's running with
`sudo household-deploy "$(sudo cut -d@ -f2 /srv/household/image)"`. Every later push to `main` deploys
itself.

**5. Check it's up.**

```bash
curl -fsS https://house.example.com/healthz          # ok
sudo docker compose -p household ps                   # caddy, app, postgres, objects: healthy
sudo docker stats --no-stream $(sudo docker ps -q --filter label=com.docker.compose.project=household)
sudo docker logs household-app-1 2>&1 | grep -E '"event":"(listening|ports-missing-credentials)"'
sudo docker ps --format '{{.Names}} {{.Status}}'      # hindsight and docker-ib-gateway-1 still up, unchanged
free -m
```

Then log in at `https://house.example.com/` on the kitchen iPad.

### Backups on the server

`household-backup.timer` runs `household-backup` at about 03:17 every night. It runs the same backup as
above (`pg_dumpall` plus the object store's volume, with SHA-256 sums; SeaweedFS stops for a few
seconds) into `BACKUP_DEST`, and keeps the newest `BACKUP_KEEP`. When `BACKUP_REMOTE` is set, it copies
them with rsync to an off-server target (e.g. a Hetzner Storage Box, using root's SSH key). All three
are set in `/etc/household/household.conf`. Run it by hand with `sudo household-backup`, and check the
timer with `systemctl list-timers household-backup.timer`.

To restore (the procedure above, against the production project):

```bash
sudo household-restore /var/backups/household/<timestamp>
```

On a new server, run steps 2 to 4 first, put the old `.env` back into `/srv/household/.env` (from the
password manager), then restore.

### Tried on the build sandbox — 1 November 2026

There is no access to the real server from the build sandbox, so `deploy/test-deploy.sh` drives the real
`household-deploy`, `household-setup`, `household-backup` and `household-restore` against local Docker,
with a local registry standing in for GHCR. It covers:

- refusing anything but a digest;
- the first deploy waiting for setup;
- setup printing the logins;
- the app healthy behind Caddy with no helper (`/healthz` ok, everything else asking for a login,
  HTTP redirected to HTTPS);
- a broken image rolled back;
- a backup restored with the house healthy again.

`install.sh` was run on the sandbox too. Its forced command then:

- refused shells and injected commands;
- did not give the `household` user Docker, any other sudo, or `.env`;
- deployed by digest;
- found a stand-in `hindsight` on its own network without changing it.

## PR previews (FB-5)

Every PR from this repository (never a fork's) gets a preview on the same VPS: the PR's image running
the **practice household** on fakes, freshly seeded on every push, at `https://pr-<n>.<preview domain>/`.
The `preview` workflow comments the URL and the practice logins on the PR (`priya` and `tom`, password
`practice`; they are made up and guard nothing real, so they are not secrets). Closing the PR removes the
preview.

| Per preview (compose project `household-pr-<n>`) | Memory cap (swap capped too) | Reachable from |
| --- | --- | --- |
| `app` (the PR's image, `PRACTICE=true`; its object store is files in its own volume) | 192 MB | the house's Caddy |
| `postgres` (its own; thrown away with the preview) | 96 MB | that preview's app |

- **Memory:** the caps are in `x-memory` at the top of `deploy/compose.preview.yml` (288 MB a preview).
  All previews together stay within `PREVIEW_BUDGET_MB` (600 by default, set in
  `/etc/household/household.conf`), so **two previews run at once**. A third removes the oldest (the one
  deployed longest ago) first, and the workflow tells that PR so; a push to it brings it back. With the
  house's 552 MB that is 1.1 GB at most, inside the 1.9 GiB that was free.
- **Isolation:** a preview gets none of the real house's `.env`, credentials, volumes or networks, and no
  Hindsight. Its two networks are internal (no internet at all, DNS included on Docker 26 or later:
  check with `docker version`). Its containers run as non-root users with every capability dropped,
  no privilege escalation, and at most 0.75 (app) and 0.5 (Postgres) of a core and 256/128 processes.
  Its tokens and secrets (session, MCP, webhooks) are made at random on each deploy, never the practice
  defaults. Previews can reach each other's apps on the shared network, as they could through the
  internet. The only house container on the
  previews' network is Caddy, the public front, which a preview reaches exactly as the internet does;
  the house's app, Postgres and object storage are not on it. The house's Caddy serves the previews by
  adding `deploy/Caddyfile.previews` (via `deploy/compose.caddy-previews.yml`, only once a preview domain
  is set).
- **Certificates:** on demand. Caddy gets a preview's certificate the first time it is visited, and only
  while that preview is running (it asks `household-preview`'s list of running previews first), so no one
  can make it ask Let's Encrypt for arbitrary names.
- **Deploys:** `.github/workflows/preview.yml` on each push to a PR builds the image, pushes it to GHCR as
  `household-preview:pr-<n>` (its own package: `household-deploy` only pulls from `household`), and runs `ssh household@<server> "preview <n> sha256:<digest>"`; on close,
  `"preview-stop <n>"`. That uses a **second** key, forced to `household-preview`, which accepts exactly
  those two forms and nothing else. The deploy key still runs only `household-deploy`, and neither can
  run the other's command. The preview key on its own can only start and stop practice previews. But the
  workflow runs from the PR's own branch, so a PR can read any repository secret, the deploy key
  included, until step 3 below moves that key into an environment only `main` may use.
  By hand on the server: `sudo household-preview "preview-stop 12"`; running ones are listed in
  `/srv/household-previews/live`.

### Cal's one-time steps for previews

**1. DNS.** Pick a preview domain, e.g. `preview.example.com`, and add a wildcard record for it pointing at
the VPS: `*.preview.example.com. A 203.0.113.10` (and AAAA if the server has IPv6). Check with
`dig +short pr-1.preview.example.com`.

**2. The preview key, and re-running `install.sh`.** On your laptop:

```bash
ssh-keygen -t ed25519 -N '' -C household-preview -f household-preview
```

On the server, from the repo checkout (`git pull` first):

```bash
sudo deploy/install.sh --preview-domain preview.example.com --preview-key "$(cat household-preview.pub)"
```

It installs `household-preview`, `/srv/household-previews`, the second key line (the deploy key's line is
kept), the sudoers rule for both commands, the `household-previews` network, and `PREVIEW_DOMAIN` in
`/srv/household/.env`. Then redeploy the house so its Caddy picks up the preview sites:
`sudo household-deploy "$(sudo cut -d@ -f2 /srv/household/image)"`.

**3. The GitHub secret.** The host and known_hosts are the deploy workflow's own:

```bash
gh secret set HOUSEHOLD_PREVIEW_SSH_KEY < household-preview
```

Then delete the private key from the laptop. Until it exists, the preview workflow skips with a notice.

Before adding it, keep the deploy key away from PR branches (a PR's workflow can read every repository
secret): Settings → Environments → New environment `production`, Deployment branches: `main` only; add
`HOUSEHOLD_SSH_KEY` there and delete the repository-level one. The deploy workflow's `deploy` job then
needs `environment: production` (a follow-up change to `deploy.yml`, outside this issue).

**4. The cloud environment's network allowlist.** For the building agent to perform journeys on a preview
with computer use (FB-4), add the preview domain (`*.preview.example.com`) to the claude.ai cloud
environment's allowed hosts.

**5. Check it.** Open a PR: the workflow comments `https://pr-<n>.preview.example.com/`; log in as `priya`
/ `practice`. On the server: `sudo docker ps --filter name=household-pr-` and
`sudo docker stats --no-stream $(sudo docker ps -q --filter name=household-pr-)`; `hindsight`,
`docker-ib-gateway-1` and `household-*` unchanged.

### Tried on the build sandbox — 1 November 2026

`deploy/test-preview.sh` drives the real `household-preview` next to the real house (deployed by
`household-deploy`, with the preview overlay on its Caddy) against local Docker, with a local registry
standing in for GHCR. It shows:

- 20 malformed commands refused (and `household-deploy` refusing both preview forms);
- two previews up at once behind the house's Caddy, each with its own database; `priya` logs in to each,
  the house's login does not, and no practice login works on the house;
- a preview finding and reaching no house container, no stand-in Hindsight, no internet (not even a DNS
  lookup), and not Caddy's on-demand check; none of the house's secrets or files in a preview; each
  preview running as non-root with no capabilities and its own random tokens;
- a third preview evicting the oldest (containers, volumes and image gone), the caps adding up to 576 MB;
- a new push giving a fresh household without evicting anything;
- closing a PR removing its preview, and a PR with no preview getting no certificate;
- the house's containers never restarted, and its volumes and `.env` unchanged.
