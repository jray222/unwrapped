# unwrapped

Self-hosted, invite-only, multi-family gift wish list application built with Django 6.1 and PostgreSQL with Row-Level Security (RLS). Security and the "surprise rule" take precedence over features.

---

## Architecture & Implementation Status

For comprehensive architecture details, role topologies, and engineering handover notes for AI agents or contributors, refer to:
- **`CLAUDE.md`**: The binding security contract (default deny, tenant isolation twice, surprise rule, token hygiene, no custom auth).
- **`docs/authz-matrix.yaml`**: The authoritative authorization matrix.
- **`AGENTS.md`**: Detailed AI agent handover guide, current status, and exact commands.

### Completed Capabilities
- **Postgres Row-Level Security (RLS)**: Enforced via `FORCE ROW LEVEL SECURITY`, tenant policies, and `rls_definer` helper functions (migrations `0003`, `0004`, `0005`).
- **Authentication**: `django-allauth` integration with email login, invite-only registration (`is_open_for_signup = False`), and default-deny MFA gate middleware (Invariant I4).
- **Token Exchange (Rule 7)**: Bearer links for guests and assignees exchanged on first visit for an `httpOnly` session, rotated via `cycle_key`, and redirected to a clean URL. Tokens are never persisted in plaintext or logged (`TokenSanitizingFilter`).
- **Invite Accept Flow**: Single-use invites validated via `rls.accept_invite`, creating memberships and binding `Person` records atomically.
- **Authorization Matrix & Endpoints**: Declarative permission layer (`apps/authz/permissions.py`) and endpoints for families, memberships, guest links, wishlists, and items.

---

## Quick start with Docker

```sh
cp .env.example .env   # then replace every placeholder
make up                # build and start app, db and caddy (https://localhost)
make migrate           # run migrations as the migrator role
make test              # run pytest inside the app container
```

---

## Running Tests Locally (Without Docker)

Test databases clone the `template_unwrapped` template (which pre-configures `schema rls` and group roles from `db/init/02-rls-roles.sql`).

Rebuild the template once per checkout (or after changing `db/init/`):
```sh
su postgres -c "tests/make_test_template.sh"
```

### 1. Domain, Auth, Exchange & Authz Matrix Suite
Runs as the superuser role (`postgres`) against `template_unwrapped`:

```sh
PYTHONDONTWRITEBYTECODE=1 DB_NAME=unwrapped DB_USER=postgres DB_PASSWORD=postgres-local-dev DB_HOST=127.0.0.1 \
  pytest tests -q -p no:cacheprovider --ignore=tests/rls
```

### 2. PostgreSQL RLS Suite
Runs as the unprivileged application role (`rls_test_app`) against the dedicated `rls_test` database:

```sh
su postgres -c "RLS_TEST_APP=rls_test_app RLS_TEST_OWNER=rls_test_owner RLS_TEST_ADMIN_DSN='dbname=rls_test' RLS_TESTS_REQUIRED=1 DB_NAME=rls_test DB_USER=rls_test_app DB_PASSWORD=rls-test-app-pw DB_HOST=127.0.0.1 DB_PORT=5432 pytest tests/rls -q -p no:cacheprovider"
```
