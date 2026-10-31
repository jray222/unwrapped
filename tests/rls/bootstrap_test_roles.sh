#!/usr/bin/env bash
# Idempotent bootstrap of a THROWAWAY Postgres database for tests/rls.
#
# The RLS tests are only meaningful when they run as a non-superuser, non-BYPASSRLS
# role that owns nothing, against tables owned by a different (migrator) role. This
# script builds exactly that with the real db/init scripts, then migrates as the owner:
#
#   1. creates the database (default rls_test) if missing
#   2. runs db/init/01-roles.sql (owner + app login roles) if neither role exists yet
#   3. runs db/init/02-rls-roles.sql (app_runtime, rls_definer, schema rls, grants);
#      the script is idempotent
#   4. sets the two login passwords
#   5. runs `manage.py migrate` AS THE OWNER role
#
# Run it as a Postgres superuser (libpq PG* variables apply), e.g. from this repo:
#
#   su postgres -c "RLS_TEST_PYTHON=/path/to/venv/bin/python tests/rls/bootstrap_test_roles.sh"
#
# Then run the tests as the app role (the script prints the exact command).
# Never point this at a real database: it only ever touches $RLS_TEST_DB.
#
# Environment (all optional):
#   RLS_TEST_DB              database name                  (rls_test)
#   RLS_TEST_OWNER           migrator/owner role            (rls_test_owner)
#   RLS_TEST_APP             runtime login role             (rls_test_app)
#   RLS_TEST_OWNER_PASSWORD  owner password                 (rls-test-owner-pw)
#   RLS_TEST_APP_PASSWORD    app password                   (rls-test-app-pw)
#   RLS_TEST_HOST / _PORT    TCP address the owner/app roles connect to (127.0.0.1 / 5432)
#   RLS_TEST_PYTHON          interpreter with the project requirements (python)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${RLS_TEST_DB:-rls_test}"
OWNER="${RLS_TEST_OWNER:-rls_test_owner}"
APP="${RLS_TEST_APP:-rls_test_app}"
OWNER_PW="${RLS_TEST_OWNER_PASSWORD:-rls-test-owner-pw}"
APP_PW="${RLS_TEST_APP_PASSWORD:-rls-test-app-pw}"
HOST="${RLS_TEST_HOST:-127.0.0.1}"
PORT="${RLS_TEST_PORT:-5432}"
PYTHON="${RLS_TEST_PYTHON:-python}"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)

# --- 1. database ---------------------------------------------------------------
"${PSQL[@]}" -d postgres -v db="$DB" <<'SQL'
SELECT format('CREATE DATABASE %I', :'db')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
SQL

# --- 2. owner + app login roles (01-roles.sql) -----------------------------------
have_role() { "${PSQL[@]}" -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$1'"; }
owner_exists="$(have_role "$OWNER")"
app_exists="$(have_role "$APP")"
if [ -z "$owner_exists" ] && [ -z "$app_exists" ]; then
    POSTGRES_DB="$DB" APP_DB_USER="$APP" APP_DB_PASSWORD="$APP_PW" \
        MIGRATOR_DB_USER="$OWNER" MIGRATOR_DB_PASSWORD="$OWNER_PW" \
        "${PSQL[@]}" -d "$DB" -f "$ROOT/db/init/01-roles.sql"
elif [ -z "$owner_exists" ] || [ -z "$app_exists" ]; then
    echo "Only one of $OWNER / $APP exists; refusing to guess. Drop it and re-run." >&2
    exit 1
else
    # Roles exist in the cluster; grant permissions on this specific database.
    "${PSQL[@]}" -d "$DB" -v db_name="$DB" -v migrator_role="$OWNER" -v app_role="$APP" <<'SQL'
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO :"migrator_role", :"app_role";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"migrator_role";
GRANT USAGE ON SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
SQL
fi

# --- 3. group roles, schema rls, grants (02-rls-roles.sql, idempotent) -----------
POSTGRES_DB="$DB" APP_DB_USER="$APP" MIGRATOR_DB_USER="$OWNER" \
    "${PSQL[@]}" -d "$DB" -f "$ROOT/db/init/02-rls-roles.sql"

# --- 4. passwords ----------------------------------------------------------------
RLS_OWNER_PW="$OWNER_PW" RLS_APP_PW="$APP_PW" "${PSQL[@]}" -d postgres -v owner="$OWNER" -v app="$APP" <<'SQL'
\getenv owner_pw RLS_OWNER_PW
\getenv app_pw RLS_APP_PW
ALTER ROLE :"owner" PASSWORD :'owner_pw';
ALTER ROLE :"app" PASSWORD :'app_pw';
SQL

# --- 5. migrate as the owner -----------------------------------------------------
(
    cd "$ROOT"
    PYTHONDONTWRITEBYTECODE=1 DJANGO_SETTINGS_MODULE=config.settings.dev \
        DB_NAME="$DB" DB_USER="$OWNER" DB_PASSWORD="$OWNER_PW" DB_HOST="$HOST" DB_PORT="$PORT" \
        "$PYTHON" manage.py migrate --noinput
)

cat <<EOF

RLS test database ready: $DB (owner $OWNER, app role $APP).
Run the RLS tests as the app role:

  cd $ROOT && PYTHONDONTWRITEBYTECODE=1 \\
    DB_NAME=$DB DB_USER=$APP DB_PASSWORD=$APP_PW DB_HOST=$HOST DB_PORT=$PORT \\
    RLS_TEST_APP=$APP RLS_TEST_OWNER=$OWNER \\
    RLS_TEST_ADMIN_DSN="dbname=$DB" RLS_TESTS_REQUIRED=1 \\
    $PYTHON -m pytest tests/rls -q -p no:cacheprovider

RLS_TEST_ADMIN_DSN is a libpq connection string for a SUPERUSER, used only to seed
and clean test data (run the tests as the postgres OS user so peer auth works, or add
host=/user=/password= to the DSN).
EOF
