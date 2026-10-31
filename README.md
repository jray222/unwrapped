# unwrapped

## Quick start

Prerequisites: Docker with the Compose plugin, and `make`.

```sh
cp .env.example .env   # then replace every placeholder
make up                # build and start app, db and caddy (https://localhost)
make migrate           # run migrations as the migrator role
make test              # run pytest inside the app container
```

Notes:
- `db/init/01-roles.sql` only runs on an empty database volume. After changing role
  settings or passwords, run `docker compose down -v` (this deletes local data).
- Login, allauth, MFA and row-level security are not part of this scaffold yet.

## Run tests without Docker

A pytest-created test database clones the `template_unwrapped` Postgres template
(`su postgres -c "tests/make_test_template.sh"`, once per checkout and after any
`db/init/` change), because `db/init/02-rls-roles.sql` otherwise never runs for it
and migration 0003_rls fails. Migrations run under a role with CREATEDB:

```sh
DB_NAME=unwrapped DB_USER=<role with CREATEDB> DB_PASSWORD=... DB_HOST=127.0.0.1 \
  pytest tests -q -p no:cacheprovider --ignore=tests/rls
```

`tests/rls` instead needs the throwaway database from
`tests/rls/bootstrap_test_roles.sh`; the script prints the exact command.
