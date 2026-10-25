#!/bin/sh
set -e

echo "==> NextCRM Docker Entrypoint"

# Connection for pg_isready/psql: the DB_* variables when set (compose files),
# otherwise DATABASE_URL without its query string (libpq rejects Prisma
# parameters such as ?schema=).
if [ -n "${DB_HOST:-}" ]; then
  PG_CONN="host=$DB_HOST port=${DB_PORT:-5432} user=$DB_USER dbname=$DB_NAME"
  export PGPASSWORD="$DB_PASSWORD"
else
  PG_CONN="${DATABASE_URL%%\?*}"
fi

# --- 1. Wait for Postgres ---
echo "==> Waiting for PostgreSQL..."
RETRIES=30
until pg_isready -d "$PG_CONN" -q 2>/dev/null; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "ERROR: PostgreSQL did not become ready in time."
    exit 1
  fi
  echo "    Postgres not ready, retrying in 1s... ($RETRIES attempts left)"
  sleep 1
done
echo "==> PostgreSQL is ready."

# --- 2. Secrets ---
# A value set in the environment always wins. A missing one is generated once
# and saved under $SECRETS_DIR (the app_data volume), so it survives restarts
# and upgrades. Never regenerate them: a new BETTER_AUTH_SECRET logs everyone
# out, a new EMAIL_ENCRYPTION_KEY makes stored passwords and API keys
# unreadable. If the directory is not writable the container stops instead of
# running with a throwaway secret.
SECRETS_DIR=/app/data/secrets

hex32() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
base64_32() { head -c 32 /dev/urandom | base64; }

load_secret() {
  name="$1"
  generator="$2"
  eval "current=\${$name:-}"
  [ -n "$current" ] && return 0
  file="$SECRETS_DIR/$name"
  if [ ! -s "$file" ]; then
    if ! (umask 077 && mkdir -p "$SECRETS_DIR" && "$generator" > "$file.tmp" && mv "$file.tmp" "$file"); then
      echo "ERROR: $name is not set and could not be saved to $SECRETS_DIR."
      echo "       Set $name in the environment, or mount a writable volume at /app/data."
      exit 1
    fi
    echo "==> Generated $name and saved it to $file (include it in your backups)."
  fi
  export "$name=$(cat "$file")"
}

load_secret BETTER_AUTH_SECRET base64_32
load_secret EMAIL_ENCRYPTION_KEY hex32
# Shared with the bundled Inngest server, which reads the same files. That
# server only accepts hex keys, so with it an old non-hex value (e.g. the
# former default INNGEST_EVENT_KEY=local) is ignored and a key is generated.
# Keys for Inngest Cloud (any other INNGEST_BASE_URL) are left alone.
if [ "${INNGEST_BASE_URL:-}" = "http://inngest:8288" ]; then
  for name in INNGEST_SIGNING_KEY INNGEST_EVENT_KEY; do
    eval "current=\${$name:-}"
    if [ -n "$current" ] && ! printf '%s' "$current" | grep -Eq '^([0-9a-fA-F]{2})+$'; then
      echo "==> Ignoring non-hex $name from the environment."
      unset "$name"
    fi
  done
fi
load_secret INNGEST_SIGNING_KEY hex32
load_secret INNGEST_EVENT_KEY hex32

# --- 3. Run Prisma migrations ---
echo "==> Running database migrations..."
prisma migrate deploy
echo "==> Migrations complete."

# --- 4. Conditional database seed ---
# Use psql to count users directly (reliable) rather than prisma db execute
# (which emits noisy output hard to parse).
# Migrations have run, so the table exists: a failing query means a wrong
# connection, and seeding a database we cannot read would be wrong too.
echo "==> Checking if database needs seeding..."
if ! USER_COUNT=$(psql -d "$PG_CONN" -tAc 'SELECT COUNT(*) FROM "Users";'); then
  echo "ERROR: could not count users, not seeding. Check DATABASE_URL / DB_* variables."
  exit 1
fi

# Strip whitespace
USER_COUNT=$(echo "$USER_COUNT" | tr -d '[:space:]')

if [ "$USER_COUNT" = "0" ] || [ -z "$USER_COUNT" ]; then
  echo "==> No users found, seeding database..."
  prisma db seed
  echo "==> Seeding complete."
else
  echo "==> Database already has $USER_COUNT user(s), skipping seed."
fi

# --- 5. Start the application ---
echo "==> Starting NextCRM..."
exec node server.js
