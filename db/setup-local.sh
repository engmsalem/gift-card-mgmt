#!/bin/bash
# Sets up a locally installed PostgreSQL 18 (no Docker) the same way db/init/01-app-role.sh sets up
# the Docker one: an admin role that owns the schema (used by migrations), a least-privileged app
# role (DML only), DB_DATABASE and DB_DATABASE_test.
#
# Usage (Git Bash, from anywhere):
#   bash db/setup-local.sh
# Settings come from .env (DB_HOST, DB_PORT, DB_DATABASE, DB_ADMIN_USERNAME, DB_ADMIN_PASSWORD,
# DB_USERNAME, DB_PASSWORD); variables already set in the environment win. It connects as a
# PostgreSQL superuser: PGUSER (default "postgres"), with PGPASSWORD or a prompt.
#
# Safe to re-run: existing roles get their password reset to the .env value, existing databases
# are kept (it refuses one owned by another role), and the grants are re-applied.
# Unlike the Docker setup, the admin role is NOT a superuser: it only owns the two databases.
set -euo pipefail
cd "$(dirname "$0")/.."

# Not on PATH (e.g. a terminal opened before PATH was changed): try the Windows installer's folder,
# highest version first (sort -V, so 18 beats 9.6)
if ! command -v psql >/dev/null; then
  newest=$(ls -d "/c/Program Files/PostgreSQL/"*/bin/psql.exe 2>/dev/null | sort -V | tail -n 1 || true)
  [ -n "$newest" ] && PATH="$(dirname "$newest"):$PATH"
fi
command -v psql >/dev/null || {
  echo "psql not found. Install PostgreSQL 18 and add its bin folder (e.g. C:\\Program Files\\PostgreSQL\\18\\bin) to PATH." >&2
  exit 1
}

# Read .env through dotenv (the app's own parser) and turn it into safely quoted shell assignments
eval "$(node - <<'EOF'
require("dotenv").config();
const sq = (v) => "'" + String(v ?? "").replace(/'/g, "'\\''") + "'";
for (const k of ["DB_HOST", "DB_PORT", "DB_DATABASE", "DB_ADMIN_USERNAME", "DB_ADMIN_PASSWORD", "DB_USERNAME", "DB_PASSWORD"]) {
  console.log(`${k}=${sq(process.env[k])}`);
}
EOF
)"

for v in DB_DATABASE DB_ADMIN_USERNAME DB_ADMIN_PASSWORD DB_USERNAME DB_PASSWORD; do
  [ -n "${!v}" ] || { echo "$v must be set in .env" >&2; exit 1; }
done
if [ "$DB_USERNAME" = "$DB_ADMIN_USERNAME" ]; then
  echo "DB_USERNAME must differ from DB_ADMIN_USERNAME" >&2
  exit 1
fi
case "$DB_DATABASE" in *_test) echo "DB_DATABASE must not end in _test (that name is for the test database)" >&2; exit 1 ;; esac
TEST_DB="${DB_DATABASE}_test"

export PGHOST="${PGHOST:-${DB_HOST:-localhost}}"
export PGPORT="${PGPORT:-${DB_PORT:-5432}}"
export PGUSER="${PGUSER:-postgres}"
if [ -z "${PGPASSWORD:-}" ]; then
  read -r -s -p "Password for PostgreSQL superuser '$PGUSER' on $PGHOST:$PGPORT: " PGPASSWORD
  echo
  export PGPASSWORD
fi

psql_su() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

version=$(psql_su -d postgres -At -c "SHOW server_version_num")
if [ "$version" -lt 180000 ]; then
  echo "PostgreSQL 18 or newer is required (uuidv7() is built in from 18); this server is $version" >&2
  exit 1
fi

# Roles and databases. Values are psql variables, quoted by format(%I, %L): never shell-interpolated
# into SQL. \gexec runs each generated statement on its own (CREATE DATABASE can't run in a transaction).
psql_su -d postgres \
  -v admin_user="$DB_ADMIN_USERNAME" -v admin_password="$DB_ADMIN_PASSWORD" \
  -v app_user="$DB_USERNAME" -v app_password="$DB_PASSWORD" \
  -v main_db="$DB_DATABASE" -v test_db="$TEST_DB" <<'EOSQL'
SELECT format('CREATE ROLE %I LOGIN', r) FROM unnest(ARRAY[:'admin_user', :'app_user']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'admin_user', :'admin_password') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec
-- Read-only: lets the admin role see other sessions' wait state in pg_stat_activity. The
-- integration tests' lock staging (test/support/lock-staging.ts) needs it; the Docker admin role
-- has it as a superuser. Not needed by the app or migrations; leave it out on a production server.
SELECT format('GRANT pg_read_all_stats TO %I', :'admin_user') \gexec

-- An existing database must already belong to the admin role: refuse rather than take it over
SELECT format('DO $$ BEGIN RAISE EXCEPTION %L; END $$',
              'database ' || datname || ' exists but is owned by ' || pg_get_userbyid(datdba)
              || ', not ' || :'admin_user')
  FROM pg_database WHERE datname IN (:'main_db', :'test_db') AND pg_get_userbyid(datdba) <> :'admin_user' \gexec

SELECT format('CREATE DATABASE %I OWNER %I', d, :'admin_user') FROM unnest(ARRAY[:'main_db', :'test_db']) AS d
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d) \gexec
EOSQL

# Grants in each database (same as db/init/01-app-role.sh): the app role may connect and use the
# tables the admin role creates, but can't create or alter anything.
for db in "$DB_DATABASE" "$TEST_DB"; do
  psql_su -d "$db" -v app_user="$DB_USERNAME" -v admin_user="$DB_ADMIN_USERNAME" -v db_name="$db" <<'EOSQL'
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
EOSQL
done

echo "Done: roles $DB_ADMIN_USERNAME (owner) and $DB_USERNAME (app), databases $DB_DATABASE and $TEST_DB on $PGHOST:$PGPORT."
echo "Next: npm run migration:run, then npm run dev."
