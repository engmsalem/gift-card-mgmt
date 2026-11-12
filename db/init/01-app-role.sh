#!/bin/bash
# Runs once, on first initialisation of the data volume (docker-entrypoint-initdb.d).
# Creates the least-privileged app role (DML only, no DDL) and a "<db>_test" database.
set -euo pipefail

TEST_DB="${POSTGRES_DB}_test"

# Secrets are passed as psql variables and quoted by psql (:"ident" / :'literal'),
# never interpolated into the SQL text by the shell.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" \
  -v admin_user="$POSTGRES_USER" -v test_db="$TEST_DB" <<'EOSQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password';
CREATE DATABASE :"test_db" OWNER :"admin_user";
EOSQL

for db in "$POSTGRES_DB" "$TEST_DB"; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
    -v app_user="$APP_DB_USER" -v admin_user="$POSTGRES_USER" -v db_name="$db" <<'EOSQL'
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"admin_user" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
EOSQL
done
