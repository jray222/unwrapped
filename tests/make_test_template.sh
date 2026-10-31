#!/usr/bin/env bash
# Build the Postgres TEMPLATE database that pytest clones for its test database
# (TEST["TEMPLATE"], see config/settings/base.py).
#
# Why: db/init/02-rls-roles.sql (schema rls, group roles, grants) only runs on the
# main data volume, so a pytest-django-created test database would fail migration
# 0003_rls. Cloning a template that already carries those objects matches the
# compose deployment semantics. 0003 must NOT be edited: it is applied on real
# installs, and the bug only ever manifests on fresh test databases.
#
# Run as a Postgres superuser (libpq peer/socket auth applies), e.g. from the repo:
#
#   su postgres -c "tests/make_test_template.sh"
#
# Then just run pytest with DB_NAME / DB_USER / DB_PASSWORD / DB_HOST as usual.
#
# Environment (all optional):
#   TEST_DB_TEMPLATE          template database name        (template_unwrapped)
#   TEST_TEMPLATE_APP_ROLE    runtime login role            (unwrapped_app)
#   TEST_TEMPLATE_MIGRATOR_ROLE  migrator/owner login role  (unwrapped_migrator)
#
# The rebuild is intentionally total: an empty database + the current
# db/init/02-rls-roles.sql is cheap and always matches the checked-in scripts.
# Neither login role is created here: if they are missing, point the user at
# tests/rls/bootstrap_test_roles.sh (which runs the non-idempotent 01-roles.sql).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${TEST_DB_TEMPLATE:-template_unwrapped}"
APP_ROLE="${TEST_TEMPLATE_APP_ROLE:-unwrapped_app}"
MIGRATOR_ROLE="${TEST_TEMPLATE_MIGRATOR_ROLE:-unwrapped_migrator}"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)

for role in "$APP_ROLE" "$MIGRATOR_ROLE"; do
    if [ -z "$("${PSQL[@]}" -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$role'")" ]; then
        echo "Role '$role' is missing. Create the login roles first, e.g.:" >&2
        echo "  su postgres -c \"RLS_TEST_DB=<dev db> RLS_TEST_OWNER=$MIGRATOR_ROLE RLS_TEST_APP=$APP_ROLE tests/rls/bootstrap_test_roles.sh\"" >&2
        exit 1
    fi
done

# WITH (FORCE) (Postgres 13+) drops the template even if a stray session lingers.
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"$TEMPLATE\" WITH (FORCE)"
"${PSQL[@]}" -d postgres -c "CREATE DATABASE \"$TEMPLATE\""

# db/init/02-rls-roles.sql only needs APP_DB_USER (app role) and
# MIGRATOR_DB_USER (migrator role); it holds no passwords.
POSTGRES_DB="$TEMPLATE" APP_DB_USER="$APP_ROLE" MIGRATOR_DB_USER="$MIGRATOR_ROLE" \
    "${PSQL[@]}" -d "$TEMPLATE" -f "$ROOT/db/init/02-rls-roles.sql"

# Marking datistemplate lets CREATE DATABASE ... TEMPLATE work for ANY role with
# CREATEDB (pytest runs migrations as the migrator role), not just the owner.
"${PSQL[@]}" -d postgres -c "ALTER DATABASE \"$TEMPLATE\" WITH is_template true"

cat <<EOF

Test template database ready: $TEMPLATE (roles $MIGRATOR_ROLE / $APP_ROLE).
pytest runs migrations as the migrator role, which needs CREATEDB (dev-only grant, do
not add to prod roles):

  su postgres -c "psql -c 'ALTER ROLE $MIGRATOR_ROLE CREATEDB'"   # dev-only

  DB_NAME=<main db> DB_USER=$MIGRATOR_ROLE DB_PASSWORD=... DB_HOST=127.0.0.1 \\
    python -m pytest tests -q -p no:cacheprovider --ignore=tests/rls
EOF
