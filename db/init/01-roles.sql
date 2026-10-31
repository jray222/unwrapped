-- Runs once, on first init of an empty data volume, as the bootstrap superuser.
-- Role names, passwords and the database name come from the db container env
-- via psql \getenv (psql 15+); nothing secret is hardcoded here.
--
-- Roles and grants only. NO row-level security policies live here: RLS is
-- reserved for a separate PR that gets an Opus review.

\set ON_ERROR_STOP on

\getenv db_name POSTGRES_DB
\getenv app_role APP_DB_USER
\getenv app_pw APP_DB_PASSWORD
\getenv migrator_role MIGRATOR_DB_USER
\getenv migrator_pw MIGRATOR_DB_PASSWORD

-- Owns the schema objects (tables created by migrations). Not used at runtime.
CREATE ROLE :"migrator_role" LOGIN PASSWORD :'migrator_pw'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Runtime role used by the app. Never owns tables, cannot bypass RLS.
CREATE ROLE :"app_role" LOGIN PASSWORD :'app_pw'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO :"migrator_role", :"app_role";

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"migrator_role";
GRANT USAGE ON SCHEMA public TO :"app_role";

-- Tables and sequences the migrator creates later become usable by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
