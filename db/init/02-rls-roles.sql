-- Runs once on first init of an empty data volume (after 01-roles.sql), as the
-- bootstrap superuser, in the application database. Existing volumes never re-run
-- docker-entrypoint-initdb.d; apply it once by hand:
--
--   docker compose exec -T db sh -c \
--     'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/02-rls-roles.sql'
--
-- The script is idempotent. It creates the fixed-name group roles that the RLS
-- migration (apps/families/migrations/0003_rls.py) names in GRANTs and policies:
--
--   app_runtime  every runtime privilege and RLS policy targets this role; the
--                env-named login role is a member and inherits from it.
--   rls_definer  owns schema "rls" and the SECURITY DEFINER helper functions.
--                NOLOGIN and NOBYPASSRLS: it reads tenant tables only through
--                explicit grants and policies written TO rls_definer.
--
-- Roles and grants only; the policies themselves live in the migration.

\set ON_ERROR_STOP on

\getenv app_role APP_DB_USER
\getenv migrator_role MIGRATOR_DB_USER

SELECT 'CREATE ROLE app_runtime NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') \gexec
SELECT 'CREATE ROLE rls_definer NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rls_definer') \gexec

ALTER ROLE app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE rls_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- The runtime login role gets app_runtime's privileges and policies (INHERIT), but
-- cannot SET ROLE to it. It is deliberately NOT a member of rls_definer.
GRANT app_runtime TO :"app_role" WITH INHERIT TRUE, SET FALSE;
-- The migrator may SET ROLE rls_definer inside a migration to create helper functions.
GRANT rls_definer TO :"migrator_role" WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA IF NOT EXISTS rls AUTHORIZATION rls_definer;
ALTER SCHEMA rls OWNER TO rls_definer;
REVOKE ALL ON SCHEMA rls FROM PUBLIC;
GRANT USAGE ON SCHEMA rls TO app_runtime, :"migrator_role";
GRANT USAGE ON SCHEMA public TO rls_definer;

-- Functions rls_definer creates are not executable by PUBLIC unless granted.
ALTER DEFAULT PRIVILEGES FOR ROLE rls_definer REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Existing installs: move whatever the login role held directly (01-roles.sql
-- defaults) onto the group role. No-ops on a fresh volume (no tables yet).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Replace the login-role-targeted defaults with group-targeted ones.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    REVOKE USAGE, SELECT ON SEQUENCES FROM :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Every request is a transaction now, so guard pooled/persistent connections.
ALTER ROLE :"app_role" SET search_path = public;
ALTER ROLE :"app_role" SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE :"app_role" SET statement_timeout = '10s';
ALTER ROLE :"app_role" SET row_security = on;
