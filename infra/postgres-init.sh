#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=migrator_password="$REFREF_MIGRATOR_PASSWORD" \
  --set=app_password="$REFREF_APP_PASSWORD" <<'SQL'
CREATE ROLE refref_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE refref_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 12 PASSWORD :'app_password';
ALTER DATABASE refref OWNER TO refref_migrator;
REVOKE ALL ON DATABASE refref FROM PUBLIC;
GRANT CONNECT ON DATABASE refref TO refref_app;
ALTER SCHEMA public OWNER TO refref_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO refref_app;
ALTER DEFAULT PRIVILEGES FOR ROLE refref_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO refref_app;
ALTER DEFAULT PRIVILEGES FOR ROLE refref_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO refref_app;
ALTER ROLE refref_app SET statement_timeout = '5s';
ALTER ROLE refref_app SET lock_timeout = '2s';
ALTER ROLE refref_app SET idle_in_transaction_session_timeout = '10s';
SQL
