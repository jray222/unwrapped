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
