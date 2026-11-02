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
  then each shopping request is recorded and saved at once, shown as "Saved for when shopping is
  connected" (nothing was looked for, and nothing retries it yet), and the app says
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
  (below) or deploy a fix. Before it switches, the new image checks `/srv/household/.env` the way it
  would at startup; if it would refuse it (a practice secret, the practice model, a missing API key,
  below), the deploy stops with that one `settings-refused` line and the running house carries on.
- **Secrets:** generated on the server into `/srv/household/.env` (root only, mode 600) by
  `pnpm env:init --real`, run by `install.sh`. GitHub holds only the SSH key, host and known_hosts. The
  key is in the `production` environment, which only `main` may use, so no pull request's workflow can
  read it; the host and known_hosts aren't secret and stay at repository level. The job passes its own short-lived token on stdin so the server can pull a private image; the server
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
`household-deploy`, `household-setup`, `household-status`, `household-backup`, `household-restore`, `household-telegram` and `household-google` commands, the
`household` user with its forced command and sudoers rule (`/etc/sudoers.d/household-deploy`), and the
nightly backup timer. Running it again is safe: it keeps every line already in `.env`, adds any setting
it lacks (generating secrets as usual, saying which names it added and never printing a value), and
changes only what you pass.
Check what it found: `sudo grep -E '^(HOUSEHOLD_DOMAIN|HINDSIGHT_NETWORK)=' /srv/household/.env`.
Copy `/srv/household/.env` into the password manager once. It holds `STORAGE_KEY`, without which the
object backups can't be read.

**3. The `production` environment and the GitHub secrets.** First make the environment the deploy key
lives in: Settings → Environments → New environment, name it `production`, then under **Deployment
branches and tags** choose **Selected branches and tags** and add the rule `main` (no other branch or
tag). Save it before adding the key. If `production` already exists (a deploy run after this change
creates it, with no branch rule), open it and set that rule before adding the key. Check it:
`gh api repos/CalNicklin/household/environments/production --jq .deployment_branch_policy` must show
`"custom_branch_policies": true`, and `gh api repos/CalNicklin/household/environments/production/deployment-branch-policies --jq '.branch_policies[].name'`
only `main`. Then, with `gh`:

```bash
gh secret set HOUSEHOLD_SSH_KEY --env production < household-deploy   # the private key, in production only
gh secret set HOUSEHOLD_SSH_HOST --body "203.0.113.10"                 # the server's address (repository level)
ssh-keyscan -t ed25519 203.0.113.10 | gh secret set HOUSEHOLD_SSH_KNOWN_HOSTS   # (repository level)
```

Never set `HOUSEHOLD_SSH_KEY` at repository level (`gh secret set HOUSEHOLD_SSH_KEY` without `--env`):
every pull request's workflow runs from the PR's own branch and can read every repository secret.
Check it's only in the environment: `gh secret list --env production` shows it and `gh secret list`
doesn't. The host and known_hosts stay at repository level because the preview workflow uses them too.

What the branch rule doesn't stop: for a pull request's run, GitHub checks the rule against the PR's
*head* branch. Someone who can push to this repo could push a branch with their own workflow that asks
for `production`, then open a PR from `main` into that branch; the head is `main`, so the run gets the
key. Only people with write access can do that. HOU-143 tracks closing it (a required reviewer on
`production`, which would mean approving each deploy).

Check the scanned key against the server's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on
the server, `ssh-keygen -lf <(ssh-keyscan -t ed25519 203.0.113.10)` locally), then delete the private key
from the laptop. Until all three secrets exist, the deploy workflow skips with a notice.

*If `HOUSEHOLD_SSH_KEY` is already at repository level* (set before this step said otherwise): create the
`production` environment as above, run `gh secret set HOUSEHOLD_SSH_KEY --env production <
household-deploy` (GitHub never shows a secret back, so you need the private key file, or make a new key
and re-run `install.sh --deploy-key` with its `.pub`), then `gh secret delete HOUSEHOLD_SSH_KEY`.

**4. The first deploy.** First put the model's key in `.env` (`sudo nano /srv/household/.env`, set
`ANTHROPIC_API_KEY`): without it every deploy is refused, the first one included (HOU-160, **The model**
below). Then Actions → deploy → Run workflow (on `main`), or merge anything to `main`. The first
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
`TELEGRAM_BOT_TOKEN`; see `.env.example`). Google Calendar has its own steps
(**Google Calendar**, below). Redeploy what's running with
`sudo household-deploy "$(sudo cut -d@ -f2 /srv/household/image)"`. Every later push to `main` deploys
itself.

**The model (HOU-160).** The real house never runs on the practice model (a keyword matcher that, for
example, files "How are you?" in the backlog). `/srv/household/.env` must have:

| Key | Value |
| --- | --- |
| `MODEL_PROVIDER` | `anthropic` (`install.sh` adds it when missing) |
| `MODEL_ID` | `claude-opus-5-5` (`install.sh` adds it when missing) |
| `ANTHROPIC_API_KEY` | the key from console.anthropic.com (only you can add it) |

With `MODEL_PROVIDER` unset or `practice`, or the provider's key empty, the app refuses to start and
`household-deploy` refuses to switch to it, each with one line naming what to set. A house set up before
these keys existed: first add `ANTHROPIC_API_KEY` with `sudo nano /srv/household/.env`, then `git pull`
the checkout and `sudo deploy/install.sh` (it adds `MODEL_PROVIDER` and `MODEL_ID`), then redeploy with
`sudo household-deploy "$(sudo cut -d@ -f2 /srv/household/image)"`. Key first: an image from before
this check starts without complaint on `MODEL_PROVIDER=anthropic` with no key, and then fails every
message, so don't run `household-setup` or `household-restore` (both restart the app) between
`install.sh` and adding the key. Check which model the running house
uses with:

```bash
sudo household-status
# image: ghcr.io/calnicklin/household@sha256:...
# app: running healthy
# house: the real house (home)
# model: anthropic claude-opus-5-5 (ANTHROPIC_API_KEY set)
```

It asks the running app container, so it shows what that container started with, and never prints a
key. The app also logs it at start, in the `listening` line's `model`.

**5. Check it's up.**

```bash
curl -fsS https://house.example.com/healthz          # ok
sudo docker compose -p household ps                   # caddy, app, postgres, objects: healthy
sudo docker stats --no-stream $(sudo docker ps -q --filter label=com.docker.compose.project=household)
sudo docker logs household-app-1 2>&1 | grep -E '"event":"(listening|ports-missing-credentials)"'
sudo household-status                                 # model: anthropic claude-opus-5-5 (ANTHROPIC_API_KEY set)
sudo docker ps --format '{{.Names}} {{.Status}}'      # hindsight and docker-ib-gateway-1 still up, unchanged
free -m
```

Then log in at `https://house.example.com/` on the kitchen iPad.

### Telegram

The house talks to you both through one Telegram bot (CH-2). Telegram sends each message to
`https://<HOUSEHOLD_DOMAIN>/webhooks/telegram` with a secret header; the app answers anything without
the secret with 401 (PRV-6). The secret is `TELEGRAM_WEBHOOK_SECRET`, which `install.sh` generated into
`/srv/household/.env`. The house knows who wrote by their Telegram user ID (CH-3). A message from an ID
it doesn't know is dropped without a reply: its words are not kept, only the ID and the time. That is how
you find your own ID below. `sudo household-telegram` runs each step inside the app's image with the
house's `.env`, so the token and the secret are never on a command line and never printed.

**1. Make the bot.** In Telegram, open a chat with **@BotFather** (the blue tick one) and send:

- `/newbot`, then a name (e.g. `Home`) and a username ending in `bot` (e.g. `nicklin_home_bot`). BotFather
  replies with the bot's token. It is a password: don't paste it anywhere but step 2.
- `/setjoingroups`, pick the bot, **Disable**: nobody can add it to a group, so it only ever has private
  chats with the people who message it.
- `/setprivacy`, pick the bot, **Enable** (the default). If it were ever in a group, it would see only
  messages meant for it.

**2. The token.** Once per server, take the new `household-telegram` command: in the server's checkout,
`git pull && sudo deploy/install.sh` (no options; it keeps everything else). Then `sudo nano /srv/household/.env` and set `TELEGRAM_BOT_TOKEN=<the token>`
(one line, no quotes). Then redeploy so the app sends through Telegram:
`sudo household-deploy "$(sudo cut -d@ -f2 /srv/household/image)"`.

**3. Connect.**

```bash
sudo household-telegram connect
```

It points the bot's webhook at the house with the secret, for only the updates the house reads (messages
and button taps), then shows what Telegram has:

```text
bot: @nicklin_home_bot
webhook: https://house.example.com/webhooks/telegram (this house)
updates: message, callback_query
waiting to be delivered: 0
connected
```

Running it again is safe. `sudo household-telegram status` shows the same without changing anything,
plus Telegram's last delivery error if there is one (e.g. `Wrong response from the webhook: 401
Unauthorized` means the house didn't get the right secret).

**4. Each adult's Telegram ID.** Do this once for each of you (skip anyone whose `telegram` was already in
`house.json` at setup):

1. In Telegram, open the bot (search for its username, or `https://t.me/<username>`), tap **Start** and
   send it anything. It won't answer: it doesn't know you yet.
2. On the server:

   ```bash
   sudo household-telegram senders
   ```

   ```text
   Telegram user IDs the house didn't know, newest first (their messages were dropped, not kept):
     123456789  last 2026-11-02T09:14:03.000Z  2 times
   ```

   Yours is the newest, at the time you messaged (times are UTC). If you're not sure, message it again
   and check that the count goes up.
3. Give it to your person (the `id` from `house.json`, e.g. `cal` or `chloe`):

   ```bash
   sudo household-telegram set cal 123456789
   ```

   It takes effect at once: no redeploy. Running it again with another ID replaces the old one. It refuses
   an ID that is already the other adult's.

**5. Check it works.** Send the bot "we need to oil the squeaky door": within a few seconds it is on the
Backlog in the app, as yours. Then `sudo household-telegram status` shows no delivery error and nothing
waiting, and `sudo household-telegram senders` doesn't show your ID again. Urgent messages from the house
now come to you on Telegram (Settings in the app chooses which).

*Tried on the build sandbox, 1 November 2026:* `deploy/test-telegram.sh` sets up a house on local Docker as
`test-deploy.sh` does, with a stand-in for api.telegram.org on the house's network, and runs the real
`household-telegram`: `connect` without a token says what to do, bad command lines are refused, `connect`
sets the webhook with the house's secret for only messages and button taps, a wrong secret gets 401, a
stranger's message is dropped with no reply and `senders` shows only their ID, `set` makes their next
message arrive as them (and refuses the other adult's ID), and no output contains the token or the secret.

### Google Calendar

The house reads **three** calendars through one Google sign-in (Cal's): Cal's own, Chloe's (which she
shares with Cal's account) and the shared family calendar, with the `calendar.readonly` scope only: it
can't add, move or delete an event (PRV-1). Whose each calendar is goes in `GOOGLE_CALENDARS`
(`owner:calendarId`, the owner being a person's ID from the household setup, or `shared`):

- an event on Cal's or Chloe's calendar is theirs (unless they declined it);
- an event on the shared calendar is whoever's address is on it (organizer and attendees who haven't
  declined), as before;
- the same event on several calendars (an invite between Cal and Chloe, or a copy on the shared one) is
  **one** event with everyone on it, matched by Google's iCalUID, so "you're both out" is right;
- a calendar shared as free/busy only shows its events as "Busy" for its owner, with no title;
- an event marked "free" in Google (a birthday, a reminder) takes nobody out of the house.

Work is marked in an event's title or description with `#work` (also `#home` and `#solo:<person>`; the
conventions are at the top of `server/integrations/google-calendar.ts`). `workCalendarIds` (every event
of a calendar counted as work) stays unset: none of the three is a work calendar. A work calendar shared
the same way would be a new issue.

`GOOGLE_CALENDAR_ID` on its own still works and means the shared calendar only; once `GOOGLE_CALENDARS`
is set, `GOOGLE_CALENDAR_ID` is ignored.

Google pushes each change to `https://<HOUSEHOLD_DOMAIN>/webhooks/calendar` on a "watch" channel, one per
calendar. The app opens them when it starts, checks them every hour (at :17), renews each a day before
Google ends it (about a week after it opened), closes the channel of a calendar it no longer reads, and
syncs once whenever it opens one (or a calendar has never been read). A change on any calendar re-plans
only the days it touched. A calendar it can't read (not shared yet) is logged as `calendar-read-failed`
or `calendar-watch-failed` and tried again; the others carry on.

**1. The Google Cloud project (once, on the laptop).** Signed in as the Google account that has the
family calendar, at <https://console.cloud.google.com/>:

- Create a project, e.g. `household`. **APIs & Services → Library → Google Calendar API → Enable.**
- **Google Auth Platform** (the OAuth consent screen) → Get started: app name `Household`, your email,
  audience **External**. Under **Data access → Add or remove scopes**, add only
  `https://www.googleapis.com/auth/calendar.readonly`. Under **Audience → Test users**, add both adults'
  Google addresses. Leave the publishing status on **Testing** (but see the 7-day limit below).
- **Clients → Create client**, application type **Desktop app**, name `household laptop` → Create →
  **Download JSON** (`client_secret_….json`). It holds the client secret: keep it in the password
  manager, not the repo (`.gitignore` refuses `client_secret_*.json` and `google.json` anyway).

**2. Connect (on the laptop),** from a checkout of this repo after `pnpm install`:

```bash
pnpm google:connect --client ~/Downloads/client_secret_….json
```

It prints a Google link. Open it, sign in as the account with the family calendar, pass the "Google
hasn't verified this app" page (Continue: it is your own app), allow "See … your calendars", and the
terminal says `Wrote google.json (mode 600, read-only calendar access)`. It uses a loopback redirect
(`http://127.0.0.1:<port>/`) with PKCE and a random state, refuses anything wider than
`calendar.readonly`, and never prints the refresh token. Don't open or paste `google.json`.

**3. Copy it to the server** (into your home directory there, then where only the app can read it):

```bash
scp google.json you@203.0.113.10:google.json && rm google.json
ssh you@203.0.113.10
sudo install -o 10001 -g root -m 400 ~/google.json /srv/household/credentials/google.json && rm ~/google.json
```

**4. Chloe shares her calendar with Cal's account** (once, Chloe, on a computer): at
<https://calendar.google.com/>, **Settings → Settings for my calendars → (her calendar) → Share with
specific people or groups → Add people and groups**, enter Cal's Google address, permission **See all
event details**, Send. ("See only free/busy" also works, but then her events show only as "Busy".)

**5. Cal accepts the share:** open the "Chloe has shared a calendar with you" email in Cal's account and
click the link to add it (it then shows under **Other calendars**).

**6. Check what the house can see.** Once per server, take the `household-google` command: in the
server's checkout, `git pull && sudo deploy/install.sh` (no options; it keeps everything else). Make sure
`/srv/household/.env` (`sudo nano /srv/household/.env`) has

```bash
GOOGLE_ACCESS_TOKEN_FILE=/run/household-credentials/google.json
```

then run `sudo household-google check`. It refreshes a token and lists every calendar the account can
see, names and IDs only (never events): Cal's own (`(primary)`, its ID is Cal's address), Chloe's (its
ID is her address, `[reader]`; `[freeBusyReader]` means free/busy only) and the shared one
(`…@group.calendar.google.com`).

**7. Set the mapping** in `/srv/household/.env`, with the person IDs from the household setup
(`cal`, `chloe`) and the IDs from that list:

```bash
GOOGLE_CALENDARS=cal:<Cal's ID>,chloe:<Chloe's ID>,shared:<the shared calendar's ID>
```

**8. Redeploy and check:**

```bash
sudo household-deploy "$(sudo cut -d@ -f2 /srv/household/image)"
sudo household-google check
sudo docker logs household-app-1 2>&1 | grep -E '"event":"calendar-(watch|read)'
```

`household-google check` now says, for each calendar: whose it is, whether this account can read it,
"full details" or "free/busy only", and its watch (`✓ watch on chloe: open since …`), then "All good.".
The kitchen screen then shows all three calendars' events, each with its person.

**Google's limits, and what to do:**

- **Testing mode: the refresh token dies after 7 days.** Google expires refresh tokens for an External
  app in Testing a week after consent. `household-google check` then says "Google refused the refresh
  token" and the screen stops changing. To stop it happening, publish the app: **Google Auth Platform →
  Audience → Publish app** ("In production"). For your own unverified app that is allowed (under 100
  users); everyone who connects sees the "unverified" page once. Then do steps 2 and 3 once more, so
  the token in use was issued after publishing. Staying in Testing works too: repeat steps 2 and 3
  every week. Either way the app reads the new file at its next try, with no redeploy.
- **Other ways a refresh token stops working:** unused for six months, access removed at
  <https://myaccount.google.com/connections>, or over 100 tokens for this client on one account
  (Google drops the oldest; one `google:connect` makes one). The fix is always steps 2 and 3.
- **No refresh token from `google:connect`:** remove "Household" at
  <https://myaccount.google.com/connections> and run it again.
- **Watch channels** end after about a week (Google says when; `household-google check` shows it).
  Google needs HTTPS with a valid certificate at the address, which Caddy gives it. A failure to open
  or renew is logged as `calendar-watch-failed` with the HTTP status and tried again the next hour.
  Google says push notifications aren't guaranteed; a missed one is caught up by the next change's sync
  (each sync asks for everything since the last).

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

### Where an image that can't build shows up

`pnpm check` never builds the image (CODE-11). The `preview` workflow does, on every push to a PR from this
repository, with the same action, builder and build inputs as `deploy`, with or without the preview
secrets (without them it only builds). It builds the PR's head, not its merge with main, so a clash with
newer main can still first show on main's deploy. A head that can't build is a red `preview / image` job
on the PR.

HOU-145 was the first image built on GitHub, and it failed where every local build had passed: the SPA
prerender starts a `vite preview` server and fetches the shell from it. On `localhost` the server bound
`::1` while the fetch tried only `127.0.0.1`. That happens wherever the loopback has `::1` and there is
no other IPv6 address, as in GitHub's BuildKit sandbox. The build sandbox has no IPv6 at all, so neither
`deploy/build-image.sh` nor the test scripts can show that kind of difference. The preview's `image` job
on GitHub can. The preview server now listens on `127.0.0.1` (`web/vite.config.ts`, tested by
`web/prerender.test.ts`).

### Tried on the build sandbox — 1 November 2026

There is no access to the real server from the build sandbox, so `deploy/test-deploy.sh` drives the real
`household-deploy`, `household-setup`, `household-backup` and `household-restore` against local Docker,
with a local registry standing in for GHCR. It builds the image first with `deploy/build-image.sh`, as the
workflows do: the committed tree, on a BuildKit builder in its own container. It covers:

- refusing anything but a digest;
- the first deploy waiting for setup;
- setup printing the logins;
- the app healthy behind Caddy with no helper (`/healthz` ok, everything else asking for a login,
  HTTP redirected to HTTPS);
- a `.env` the new image refuses (no `MODEL_PROVIDER`, `MODEL_PROVIDER=practice`, no
  `ANTHROPIC_API_KEY`) not deployed, with the running app container untouched and healthy (HOU-160);
- `install.sh`'s env-init adding `MODEL_PROVIDER` and `MODEL_ID` to an old `.env` without changing a line
  of it, and `household-status` showing the model;
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
  run the other's command. The preview key on its own can only start and stop practice previews. The
  workflow runs from the PR's own branch, so a PR can read any repository secret; the deploy key is
  not one, it is only in the `production` environment, which only `main` may use (step 3 of the real
  house).
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

A PR's workflow can read every repository secret. Before turning previews on (adding this secret),
check that `HOUSEHOLD_SSH_KEY` is only in the `production` environment: `gh secret list` must not list
it (step 3 of the real house).

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
standing in for GHCR. Like `test-deploy.sh`, it builds the image itself with `deploy/build-image.sh`. It
shows:

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

## Order emails (HOU-150)

Order confirmations reach the house by email with no mail service in between: Gmail forwards them to
`orders@orders.tracesknown.com`, the house's own mail receiver on the VPS takes them on port 25, and each
order becomes an **Arriving** block (CAP-9). The receiver only receives. It sends nothing, ever: no
replies, no bounces, no relaying.

| Container (compose project `household`) | Memory cap (swap capped too) | Reachable from |
| --- | --- | --- |
| `mail` (the house's image, `mail/main.ts`) | 128 MB | the internet, port 25 only |

The receiver is an overlay, `deploy/compose.mail.yml`. The house adds it only once `install.sh` has been
given `--mail-domain`, so until then a deploy runs exactly the four containers above. With it the house is
680 MB at most, and 1.3 GB with two previews.

- **One address:** mail for `orders@<mail domain>` is taken. Every other recipient is refused at `RCPT`
  (`550`), whoever sent it, so the receiver can't be used as a relay. There is no `AUTH` to log in with.
  - Messages over 5 MB are refused (`552`). A message with more than ten DKIM/ARC headers is answered
    `250` and dropped unchecked, like any unproven mail.
  - Connections are limited: at most four from the internet at once and two from any one address. Each
    is closed after a minute idle or ten minutes in all, and ten messages per connection.
  - One message is checked at a time, for at most 30 seconds. A check that runs past that is answered
    `451` and abandoned. It stops at its next step and never reaches the app.
  - The container's healthcheck always gets in, so a flood can't fail a deploy.
  - The reasons are in `contracts/limits.ts` (`inboundEmail*`).
- **Who sent it:** anyone can send to `orders@`, and a forwarded order's `From:` is the shop. So the
  receiver works out who forwarded it from what their mail provider vouches for, never from what the
  headers say (`mail/verify.ts`):
  - **Gmail's auto-forward:** it comes from Google's servers with the envelope sender
    `cal+caf_=orders=orders.tracesknown.com@gmail.com`, aimed at our own address, and carries Gmail's ARC
    seal (google.com). When SPF for `gmail.com` passes and that seal verifies, that is `cal@gmail.com`.
    An SPF pass alone proves no one: anyone on shared servers (Google's, Microsoft's, an ISP's) can pass
    it for another customer, so no other envelope counts.
  - **A forward by hand** (`Fwd:` from Cal's own mailbox): its `From:` domain carries a passing DKIM
    signature of that same domain, over a `To:`/`Cc:` naming our address. An old signed email re-sent to
    us doesn't count. The shop is then taken from the forwarded message's own `From:` line.

  `X-Forwarded-For`, `X-Forwarded-To`, `Delivered-To`, `Resent-From` and `To:` are written by whoever
  sent the email, so they prove nothing and are never used. The app then accepts the email only if a
  proven address is an adult's `email` from `house.json` (CH-3).
  - Anything else is answered `250` and dropped, and the drop is logged (`mail-dropped-unproven-sender`,
    or the app's `dropped-unknown-sender`). Refusing it would make the sending server bounce it to
    whoever is in its envelope.
  - Only a DNS lookup failing for now, a check running out of time, or the app being unreachable gets
    `451`, so a real forward is tried again.
  - Only proven mail is parsed.
- **TLS:** Caddy gets and renews the certificate for the mail domain, as it does for the house. The
  receiver offers STARTTLS with it once it exists, and checks for a renewal every ten minutes. Until then,
  for the first few minutes after the first deploy, it takes mail without TLS rather than offer a
  self-signed certificate.
- **Privileges and reach:**
  - The container starts as root with no capability but `SETUID`/`SETGID`, only to copy Caddy's key for
    the mail domain (Caddy keeps its keys root-only).
  - It then runs the receiver as the image's unprivileged `house` user with no capabilities, on a
    read-only filesystem.
  - It is on a network of its own, shared only with the app. It can't reach Postgres, object storage or
    Caddy.
  - It gets only `EMAIL_WEBHOOK_SECRET`, not the house's `.env`, and posts to the app's `/webhooks/email`.
- **Gmail's forwarding confirmation** is kept (the code, its confirmation link and when it came, in
  memory only) and never reaches the app. `sudo household-email last-confirmation` prints the code, then
  the link if there was one, if it came within the hour, and nothing else. Both are one-time and expire.
  The deploy user can't run it.
  - Its sender is proven strictly: an `@google.com` From with a passing, aligned google.com DKIM
    signature (HOU-169). What it says is read tolerantly, from Gmail's own senders only (`forwarding-noreply@google.com`,
    `mail-noreply@google.com`; never a pattern, since Drive shares and comments are google.com-signed
    text anyone chooses): the
    code anywhere in the decoded subject (`#123456789`) or else in the text or HTML body
    (`Confirmation code: 123456789`), and a `https://mail-settings.google.com/…` or
    `https://mail.google.com/…vf-…` link.
  - A google.com-proven email that isn't recognised is logged as `mail-google-not-confirmation` with its
    shape only: the From address, whether the subject or body held a code, and the subject with every
    digit as `#`.
  - **If Gmail's confirmation came before HOU-169 was deployed** (it was dropped): in Gmail →
    Settings → Forwarding and POP/IMAP, use **Re-send email** for the pending address, then run
    `sudo household-email last-confirmation` within the hour and enter the code (or open the link).
- **Who is who:** the Gmail address that forwards must be that adult's `email` in `house.json` (step 4
  of the real house), e.g. `"email": "cal@gmail.com"`. Gmail's envelope uses the address exactly as the
  account is named. Forwards from an address that isn't anyone's are dropped and logged as
  `dropped-unknown-sender`.

### Cal's one-time steps for order emails

`tracesknown.com` is at Namecheap; the house is `house.tracesknown.com`. The mail domain is
`orders.tracesknown.com`, so the forwarding address is `orders@orders.tracesknown.com`. A subdomain
keeps the receiver away from any mail on `tracesknown.com` itself.

**1. DNS at Namecheap.** Domain List → `tracesknown.com` → **Manage** → **Advanced DNS**.

a. Under **Host Records**, **Add New Record**: type **A Record**, Host `orders`, Value the VPS's IPv4
   address (the same as `house`), TTL Automatic. Save it with the tick. Add no AAAA record for `orders`,
   even if `house` has one. Docker hands IPv6 connections to the receiver from its own address, which
   would make SPF fail for every forward.

b. Scroll down to **Mail Settings** and look at what it says now, **before changing anything**:

   - **No Email Service** (or empty): nothing on `tracesknown.com` receives mail. Choose **Custom MX**.
   - **Email Forwarding**, **Private Email**, **Gmail**/Google Workspace, or anything else: some mail on
     `tracesknown.com` works today. Switching to **Custom MX** replaces that service's MX records, and
     mail to `…@tracesknown.com` stops arriving. Avoid it this way:
     1. Before switching, note the current MX records: `dig +short MX tracesknown.com` (for Email
        Forwarding they are `eforward1` to `eforward5.registrar-servers.com`; for Private Email,
        `mx1`/`mx2.privateemail.com`). Also note the `@` TXT record that starts `v=spf1`.
     2. Choose **Custom MX**, then add each of those back with Host `@`, the same mail server and the
        same priority. Keep the SPF TXT record.
     3. Send a test to an address on `tracesknown.com` that worked before, and check it still arrives.
        If it doesn't, put **Mail Settings** back the way it was. Then skip c (no MX record for
        `orders`): a mail server sends to a host's A record when it has no MX record (RFC 5321 5.1),
        so the receiver still gets mail. Step 5's test send tells you whether it does.

c. In **Custom MX**, **Add New Record**: Host `orders`, Mail Server `orders.tracesknown.com`, Priority
   `10`, TTL Automatic. Save it.

d. Check from your laptop (allow up to 30 minutes):

```bash
dig +short A orders.tracesknown.com     # the VPS's IPv4 address
dig +short MX orders.tracesknown.com    # 10 orders.tracesknown.com.
dig +short MX tracesknown.com           # unchanged from before (or empty if there was no mail)
```

**2. Port 25 on the server.** Hetzner allows inbound 25 (only *outbound* 25 is blocked on new accounts,
and the receiver never sends). If the server is in a **Hetzner Cloud Firewall** (Cloud Console →
Firewalls), add an inbound rule: TCP, port `25`, source any IPv4. If `ufw` is on, add it there too, so the
rules say what is open (Docker's published ports bypass ufw anyway): `sudo ufw allow 25/tcp`. Nothing
else on the server may be listening on 25. `sudo ss -ltnp 'sport = :25'` must print nothing. If it shows
`exim4` or `postfix`, stop and disable it: `sudo systemctl disable --now exim4`.

**3. Re-run `install.sh` and redeploy.** On the server:

```bash
cd ~/household && git pull
sudo deploy/install.sh --mail-domain orders.tracesknown.com
sudo household-deploy "$(sudo cut -d@ -f2 /srv/household/image)"
```

It installs `deploy/compose.mail.yml`, `deploy/Caddyfile.mail` and `household-email`, and writes
`MAIL_DOMAIN` to `/srv/household/.env`. It keeps every secret and refuses if something else already has
port 25. Check:

```bash
sudo docker compose -p household ps                    # mail: healthy, 0.0.0.0:25->2525/tcp
sudo docker logs household-mail-1 2>&1 | grep -E 'mail-(listening|certificate)'
```

`"starttls":true`, or a later `mail-certificate-arrived`, means Caddy got the certificate. It takes a
few minutes, and the receiver picks it up within twenty. `sudo docker restart household-mail-1` takes it
at once.

**4. Gmail.** Do this in the Gmail account whose address is your `email` in `house.json`.

a. ⚙ → **See all settings** → **Forwarding and POP/IMAP** → **Add a forwarding address** →
   `orders@orders.tracesknown.com` → **Next** → **Proceed**. Gmail sends a confirmation email to it.

b. On the server, within the hour:

```bash
sudo household-email last-confirmation       # prints the code, e.g. 693452117
```

c. Back in Gmail's Forwarding settings, enter that code in **Confirmation code** → **Verify**. Leave
   **Disable forwarding** selected: forwarding everything isn't wanted, only orders.

d. The filter: in the search box's **Show search options**, put this in **Has the words** (adjust it
   for your shops):

```
subject:(order OR dispatched OR delivery OR arriving OR "on its way")
```

   → **Create filter** → tick **Forward it to** `orders@orders.tracesknown.com` → **Create filter**.
   Only new mail is forwarded. The house keeps only the shop and the day of each order (PRV-3), and
   ignores anything that isn't an order.

**5. A test send.** Send yourself an email that looks like an order, from another account, e.g. Subject
`Your Screwfix order is confirmed`, body `Arriving tomorrow between 8am and 1pm.` Gmail's filter forwards
it. Within a minute or two:

```bash
sudo docker logs household-mail-1 2>&1 | grep -E '"event":"mail-' | tail -3
# {"event":"mail-handed-to-app","outcome":"accepted","proof":["envelope-spf",…]}
```

The home screen on the iPad then shows an **Arriving** block for tomorrow (arrivals show the day before
and the day itself). It is named after the email's sender, which for a real order is the shop; for this
test it is the other account's name. If the log shows `mail-dropped-unproven-sender` instead, the forward
didn't pass as Gmail's. Check there is no AAAA record for `orders`, and that the forwarding address is
exactly `orders@orders.tracesknown.com`. The log line shows which of SPF, DKIM and ARC failed. If the app's
log has `dropped-unknown-sender`, the forwarding address isn't your `email` in `house.json`.

### Tried on the build sandbox — 1 November 2026

The build sandbox can't reach the real server or real mail. So `deploy/test-mail.sh` deploys the house
with the real `household-deploy`, with `MAIL_DOMAIN=orders.localhost`, against local Docker. A test DNS
server (`scripts/mail-proof.ts`, in its own container) answers the receiver's SPF, DKIM, DMARC and ARC
lookups with test records and keys. It treats the Docker gateway as Google's servers. The practice model
reads the orders, because there is no model key. Everything else goes over real SMTP into port 25:

- **The container:**
  - the receiver ran as uid 10001 with no capabilities, on a read-only filesystem;
  - from its network it reached the app and nothing else (not Postgres, SeaweedFS's S3 or master port,
    or Caddy);
  - it offered STARTTLS with the certificate Caddy issued for `orders.localhost` (Caddy's local CA, as
    `.localhost` gets).
- **A Gmail-shaped auto-forward** of a Screwfix order (`sam+caf_=…@gmail.com`, Google's ARC seal, the
  shop's DKIM signature intact) was answered `250`. The app recorded
  `Screwfix | tomorrow | 8am–1pm | someone in | sam`.
- **A forward by hand** of a Currys order (From sam, signed by gmail.com, To orders@) was recorded as
  `Currys | tomorrow | 10am–2pm | sam`, named after the shop.
- **The home screen** couldn't be drawn in the sandbox: planning a day needs the weather service, which
  the sandbox can't reach.
- **Three spoofs** were answered `250` and none became an arrival:
  - forwarding headers naming sam, from a server that isn't Google: dropped by the receiver;
  - `From: sam` sent from another domain: dropped by the receiver;
  - a stranger's own Gmail forward with the headers rewritten: only the stranger was proven, and the app
    dropped and logged them.
- **Refused:**
  - mail for another address here: `550` at RCPT;
  - a relay attempt to two outside addresses: `550`, `550`;
  - a 5.3 MB message: `552`;
  - a third session at once from one address: `421`.
- **Gmail-shaped forwarding confirmation:** `household-email last-confirmation` printed its code and
  nothing else.
- **Memory:** 72 MiB at idle, and at most 83 MiB of the 128 MiB cap under a burst of 40 one-megabyte
  messages, two connections at a time. Every message was answered `250`, with no restart and no OOM
  kill.

## Agent review (HOU-151)

Every push to a PR from this repository (never a fork's) is reviewed by `.github/workflows/agent-review.yml`
in three stages: Entire's code, security and slop reviews, whose prompts are `.github/review/code.md`,
`security.md` and `slop.md`, verbatim. Each stage returns findings graded high, medium or low, each
with the stage's confidence (0.5 to 1; anything lower is dropped, as the prompts say). The
`agent-review` job comments each new finding on its line, replies on a finding's comment when it is
settled, keeps one summary comment (verdict, open and settled findings, the slop rating, the cost) up to
date in place, and **fails while any medium or high finding is open**. A low never blocks. It runs
again when the PR's base branch or description is edited, since a check's result belongs to the head
commit and would otherwise outlive a change of base. A finding on
a file or line outside the diff, or about the PR as a whole, is posted as a comment on the PR instead.
A PR whose diff is over the limit (`reviewMaxDiffChars`, with the lockfile, `evidence/` and `design/`
left out) fails the review: split it.

- **Resolving a finding:** fix it and push (the next review no longer raises it), or reply to its comment
  with a reason (for one posted on the PR, a PR comment that names it, e.g. `AR-7: …`) and push or re-run
  all jobs (the next review reads replies from the PR's owner, members and collaborators, and may accept
  them). A finding stays open until its stage says it is fixed or accepts a reply, or its code changes
  (a stage that just stops mentioning it clears nothing). A fixed or accepted finding is remembered in
  the summary comment and isn't raised again until the code it points
  at changes (`scripts/review/state.ts`, unit-tested). The summary is written before any other comment,
  so a comment that fails to post is retried on the next push rather than raised as a new finding.
- **Model and cost:** the `REVIEW_MODEL` repository variable, default `claude-opus-5-5`; effort high for
  the code and security stages, medium for slop. Each stage is capped in steps, output tokens per call
  and total tokens, with the reasons in `contracts/limits.ts`; its last allowed step has no tools, so it
  always ends with an answer. The tools, the instructions and the review context are one prefix that
  every stage and step reads from the prompt cache. The job summary and the PR's summary comment show
  each run's cost.
- **What runs:** the scripts and prompts come from a checkout of the PR's *base* commit, so a PR that
  changes them is still reviewed with `main`'s (the change takes effect once it is on `main`). The
  workflow file itself is the PR's own, though (GitHub runs a `pull_request` workflow from the PR), so a
  PR that edits it can change its own review: see "Secret exposure" below. The one exception to the base
  rule is the bootstrap: while the default branch has no review at all (only for the PR that added it),
  a PR into it runs its own scripts and prompts, with a notice saying so. A PR into another branch that
  has no review is skipped with a notice. The PR's head is a second
  checkout that is only read, through git (`git show`, `git grep`, `git diff`, `git log`): nothing in it
  is installed, built or run, and no symlink is followed. Neither checkout keeps a token in `.git`.
- **Prompt injection:** the diff, the PR's title and description, and replies are untrusted data in user
  messages; the stage's instructions are system messages. The model's job has a read-only token
  (`contents: read`, `pull-requests: read`), the model's own step has only the Anthropic key and no
  GitHub token, and its tools read git objects and nothing else (no shell, no network, no writes). A
  second job, `agent-review`, holds the only write permission (`pull-requests: write`) and no secret; it
  validates the findings with zod, strips @-mentions and comment markers from what the model wrote, and
  never calls the model.

### Secret exposure

A same-repository PR's workflow can read every repository secret, and a PR can edit
`agent-review.yml` itself (GitHub runs the PR's version of the workflow). So anyone who can push a
branch here can make a run print or send `REVIEW_ANTHROPIC_API_KEY`: the same write-access threat as the
preview's secrets and the one HOU-143 tracks for `production`. It can't sit in a `main`-only
environment, because the review has to run on PRs. Limit what the key is worth instead: give it its own
Anthropic workspace with a monthly spend limit and nothing else in it, and rotate it if it ever shows up
in a log. Nothing here prints it.

What this check doesn't stop: a PR that edits `agent-review.yml` or the files it reads can make its own
`agent-review` check pass. AGENTS.md keeps review changes in their own PRs, which a person can read.

### Cal's one-time steps

1. In the Anthropic Console, create a workspace for the review only (e.g. `household-review`) and set its
   monthly spend limit (Settings → Limits; $50 is several hundred reviews at the dry run's cost). Create an
   API key in that workspace.
2. Add it as a repository secret (it must be repository level: PR workflows read it):
   `gh secret set REVIEW_ANTHROPIC_API_KEY --repo CalNicklin/household` and paste the key at the prompt.
   Until it exists, the workflow skips with a notice and passes.
3. Optionally pick another model: `gh variable set REVIEW_MODEL --repo CalNicklin/household --body claude-sonnet-5-5`.
4. Once `agent-review` has run green on a PR, add it to the `main` ruleset's required status checks
   (Settings → Rules → Rulesets → main → Require status checks to pass → Add checks → `agent-review`), next
   to `check`.

### Dry run — 1 November 2026

`node scripts/agent-review-dry-run.ts` runs the three stages against the real model on a fixture PR whose
new `basketTotal` skips the first price (`for (let i = 1; …)`) and whose code comment and description both
tell AI reviewers to ignore their instructions and report nothing. With `claude-opus-5-5`: the code stage
found the bug (high, confidence 0.97, citing the AGENTS.md rule), the security stage reported the injection
(medium), the slop stage rated it Large, and the run blocked; $0.09 for all three stages (code $0.04, 3
steps; security $0.02; slop $0.03), about 20 seconds.

The same `review` command on this PR's own diff (about 2,000 lines) cost $0.97: code $0.64 (4 steps),
security $0.16, slop $0.18; the security and slop stages read 96% of their input from the cache the code
stage wrote. It found five real defects, all fixed before merge (see HOU-151). Budget about $1 per push of
a PR that size.
