# AGENTS.md — Unwrapped Engineering Handover & Agent Guide

> **Target Audience:** Any AI coding agent or LLM taking over development of `unwrapped`.
> This file contains the complete operational context, architecture status, test setup, and immediate next steps so you can resume work seamlessly.

---

## 1. Project Overview & The Contract

`unwrapped` is a self-hosted, invite-only, multi-family gift wish list application built with **Django 6.1** and **PostgreSQL 16/17** with Row-Level Security (RLS).
The binding security contract is codified in **`CLAUDE.md`** and **`docs/authz-matrix.yaml`**.

### Core Non-Negotiables
1. **Default Deny**: Every endpoint must declare authorization rules. Anonymous and unprivileged roles see nothing.
2. **Tenant Isolation Twice**: Tenant tables enforce `family_id` foreign keys at the Django level AND Row-Level Security (RLS) policies at the PostgreSQL level.
3. **The Surprise Rule**: A list's recipient must NEVER learn claim, pledge, or assignment state for their list (neither counts, names, timestamps, nor HTTP status codes — recipient requests return 404).
4. **Never Edit an Applied Migration**: Always create a new migration for schema or definer helper changes.
5. **No Custom Auth Flows**: Use `django-allauth` built-ins.
6. **Token Hygiene**: Bearer tokens (`secrets.token_urlsafe(32)`) are stored as SHA-256 digests only. On first visit, tokens are exchanged for an `httpOnly` session and redirected (302) to a clean URL. Tokens or URLs containing them are never logged (`TokenSanitizingFilter`).

---

## 2. Current Implementation Status

### Completed PRs

| Milestone | Branch | Commit | Key Changes |
|-----------|--------|--------|-------------|
| **PR-B** (RLS Policies) | `tests/rls-test-template` | `4b299aa` | Migration `0003_rls.py`, database roles (`app_runtime`, `rls_definer`), triggers, context middleware. |
| **Test Template** | `tests/rls-test-template` | `cbe2b6b` | `tests/make_test_template.sh`, `DB_TEST_TEMPLATE` setting so fresh test DBs clone `02-rls-roles.sql`. |
| **PR-C.1** (Auth Scaffold) | `feature/auth-scaffold` | `2c8dc52` | `django-allauth` (email login, signup closed via `AccountAdapter.is_open_for_signup = False`), invariant I4 MFA gate middleware (`apps/authz/mfa_gate.py`). |
| **PR-C.2** (Token Exchange) | `feature/token-exchange` | `bd84a0c` | Migration `0004_token_exchange.py` (`rls.exchange_link_token`, `rls.link_is_active`), session rotation (`cycle_key`), guest/assignment link exchange views, `TokenSanitizingFilter`. |
| **PR-C.3** (Invite Accept) | `feature/token-exchange` | `940b55f` | Migration `0005_invite_accept.py` (`rls.accept_invite`), single-use tracking, person binding, atomic user creation. |
| **PR-D Slices 1–6** | `feature/authz-permissions` | (active) | Authz test harness (5,651 test cases from `docs/authz-matrix.yaml`), permission layer (`apps/authz/permissions.py`), endpoints for family, members, invites, guest links, lists, items, claims, and pledges. |

---

## 3. Database & Role Architecture

- **Postgres Roles**:
  - `postgres` (superuser, local dev / maintenance).
  - `unwrapped_migrator` / `rls_test_owner` (migration runner, table owner, member of `rls_definer` with `NOINHERIT, SET TRUE`).
  - `unwrapped_app` / `rls_test_app` (runtime login role, member of `app_runtime`, `NOBYPASSRLS`, `NOCREATEDB`).
  - `app_runtime` (NOLOGIN group role targeting all RLS policies and table grants).
  - `rls_definer` (NOLOGIN role owning schema `rls` and `SECURITY DEFINER` functions).

- **Applied Migrations** (in `families`):
  - `0001_initial`: Core domain models (`Family`, `Membership`, `Person`, `WishList`, `Item`, `Claim`, `Pledge`, `Assignment`, `GuestLink`, `GuestLinkList`, `AssignmentLink`, `Invite`, `AuditLog`, `ClaimNotification`).
  - `0002_schema_integrity`: Composite foreign keys enforcing same-family isolation.
  - `0003_rls`: RLS policies, definer functions, triggers.
  - `0004_token_exchange`: `rls.exchange_link_token` and `rls.link_is_active`.
  - `0005_invite_accept`: `rls.accept_invite` and definer grants on `families_membership`, `families_person`, `families_invite`.

---

## 4. How to Run the Tests

The environment has a local PostgreSQL instance running at `127.0.0.1:5432`.

### Non-RLS Suite (Domain, Auth, Exchange, Security, Authz Matrix)
Runs as the superuser role (`postgres`, password `postgres-local-dev`) which clones `template_unwrapped`:

```bash
PYTHONDONTWRITEBYTECODE=1 DB_NAME=unwrapped DB_USER=postgres DB_PASSWORD=postgres-local-dev DB_HOST=127.0.0.1 \
  /tmp/opencode/venv/bin/python -m pytest tests/domain tests/auth tests/exchange tests/test_security_headers.py tests/authz/test_instance.py tests/authz/test_membership.py tests/authz/test_links.py tests/authz/test_lists.py tests/authz/test_items.py -q -p no:cacheprovider
```
*Current status: 271 passed.*

### RLS Suite (Policy and Catalog Verification)
Runs against the dedicated `rls_test` database as `rls_test_app`:

```bash
su postgres -c "RLS_TEST_APP=rls_test_app RLS_TEST_OWNER=rls_test_owner RLS_TEST_ADMIN_DSN='dbname=rls_test' RLS_TESTS_REQUIRED=1 DB_NAME=rls_test DB_USER=rls_test_app DB_PASSWORD=rls-test-app-pw DB_HOST=127.0.0.1 DB_PORT=5432 /tmp/opencode/venv/bin/python -m pytest tests/rls -q -p no:cacheprovider"
```
*Current status: 76 passed.*

### Rebuilding the Test Template
If any schema or `db/init/` changes occur:
```bash
su postgres -c "tests/make_test_template.sh"
```

---

## 5. Immediate Next Steps to Finish PR-D

You are currently on branch `feature/authz-permissions`.
The remaining work is strictly bounded to the following slices:

1. **Slice D.7: Claims & Pledges**
   - Endpoints in `apps/families/views.py`: `claim_list`, `claim_create`, `claim_release`, `pledge_list`, `pledge_create`, `pledge_detail`.
   - Verify: `pytest tests/authz/test_claims.py tests/authz/test_pledges.py`.
2. **Slice D.8: Assignments** (`tests/authz/test_assignments.py`)
   - Endpoints: `assignment_create`, `assignment_detail`, `assignment_mark_bought`, `assignment_mark_couldnt_get`, `assignment_cancel`, `assignment_share_card`.
   - Verify: `pytest tests/authz/test_assignments.py`.
3. **Slice D.9: Audit Log View** (`tests/authz/test_audit.py`)
   - Endpoint: `audit_log_view` (`GET /families/<id>/audit-log`, `family_admin` only).
   - Verify: `pytest tests/authz/test_audit.py`.
4. **Slice D.10: Invariants Suite** (`tests/authz/test_invariants.py`)
   - Run the complete suite of invariants (Surprise Rule I1, Cross-Family 404 I2, Token Hygiene I3, MFA Gate I4).

---

## 6. Rate Limit & Context Management for LLMs

- **Do NOT open subagents** or perform broad file dumps.
- Keep tool calls targeted using `read` with explicit line offsets.
- Always filter test outputs (`-q`, `tail -10`) to avoid flooding conversation history with duplicate log traces.
- If hitting a rate-limit cooldown, sleep briefly (e.g. 45-60 seconds) before resuming.
