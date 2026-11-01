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
