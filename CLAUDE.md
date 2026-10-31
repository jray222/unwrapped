# CLAUDE.md — Family Wish List

Self-hosted, invite-only, multi-family gift wish list app. Several families share
one deployment. Security and the "surprise rule" matter more than features.
When a rule below conflicts with a task, follow the rule and say so.

## Stack

- Django + Django REST Framework, server-rendered templates for the UI
- PostgreSQL with Row-Level Security (RLS)
- django-allauth: Google (OIDC), local accounts, MFA (TOTP, WebAuthn/passkeys, recovery codes)
- Docker Compose: `app`, `db`, `caddy` (TLS). App runs as non-root, read-only root FS
- Use versions pinned in `requirements.txt`. Do not add dependencies without asking.

## Principals

| Principal | How they authenticate | Notes |
|---|---|---|
| `instance_admin` | Local account + passkey | Manages families and the server. Cannot read family content. |
| `family_admin` | Google or local + MFA | Admin of one family. A user may be admin in one family, member in another. |
| `member` | Google or local + MFA | Full participant in a family. |
| `guest` | Personal guest link (no login) | Scoped to specific lists in one family. |
| `assignment_link` | Optional scoped link (no login) | Sees only their own assignments. Most assignees get a static card instead. |
| `anonymous` | None | May only hit login, invite-accept, and guest-token-exchange endpoints. |

Authorization is defined in `docs/authz-matrix.yaml`. That file is the source of
truth. If code and matrix disagree, the code is wrong. Changing the matrix
requires a human-reviewed PR.

## Security non-negotiables

1. **Default deny.** Every view and endpoint declares its required permission. No view without a permission class/decorator.
2. **Tenant isolation, twice.** Every tenant table has `family_id NOT NULL`. Querysets filter by family in the app layer, AND RLS policies enforce it in Postgres.
3. **RLS plumbing.** Middleware opens a transaction and runs `SET LOCAL app.family_id`, `app.principal_id`, `app.principal_type`. The app DB role is not superuser, not table owner, and tables use `FORCE ROW LEVEL SECURITY`. Migrations run under a separate role.
4. **The surprise rule.** A list's recipient must never learn claim, pledge, or assignment state for that list — not names, not counts, not "taken" flags, not via timestamps, ordering, error messages, or HTTP status differences. Enforce in querysets, serializers, templates, AND RLS.
5. **Edits to claimed items.** If a recipient edits or deletes a claimed item, notify the claimer. Never tell the recipient it was claimed.
6. **Tokens** (invite, guest, assignment links): `secrets.token_urlsafe(32)`, stored as SHA-256 hash only, compared in constant time. Invites: single use, 7-day expiry, bound to an email. Guest/assignment links: bound to one person, revocable, 365-day max expiry.
7. **Token exchange.** On first visit, exchange the URL token for an httpOnly session cookie and 302 to a clean URL. Set `Referrer-Policy: no-referrer` site-wide. Never log tokens or full URLs that contain them.
8. **Google sign-in.** Require `email_verified`. Link accounts by Google `sub`, never by email. First sign-in must match a pending invite's email.
9. **Local accounts.** Argon2id passwords. A local account has no access until MFA (TOTP or passkey) is enrolled. Passkey-only accounts are allowed.
10. **Sessions.** Server-side, `Secure`, `HttpOnly`, `SameSite=Lax`, rotated on login and privilege change, CSRF on all state changes, rate limits on login, MFA, and token endpoints.
11. **No server-side fetching of user-supplied URLs.** No link previews, no scraping. Render store links with `rel="noopener noreferrer"`.
12. **Uploads.** Images only, size-limited, re-encoded server-side, EXIF stripped, served from a non-executable path.
13. **Headers.** Strict CSP (no inline scripts), HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`.
14. **Audit log.** Record claims, releases, assignments, invites, link issue/revoke, role changes, and logins. Visible to the family admin.
15. **No custom crypto or auth flows.** Use allauth and Django built-ins. If something seems to require custom auth code, stop and ask.

## Domain rules

- Items can have a `quantity` and an `allow_duplicates` flag. Claims cannot exceed quantity unless duplicates are allowed.
- Claimed items show "Taken by {first name}" to non-recipients and sort into a collapsed section.
- Opening the store link of a claimed item shows a confirmation first.
- Assignments: a member assigns items to a person; the items are claimed in that person's name immediately. Status: `assigned` → `bought` | `couldnt_get`. `couldnt_get` releases or reassigns the claim.
- The shareable assignment card (PDF and PNG) is a static snapshot: item photo, name, notes, price, store name. It grants no access.
- Guest and assignment-link pages may cache read-only data offline. Queued "bought" taps sync on next online page load. Never cache data from another person's scope.

## Testing

- Tests are generated from `docs/authz-matrix.yaml` (see its `test_generation` section). Every rule gets an allow test and a deny test.
- Every endpoint needs a cross-family test: same role, other family, must be denied without leaking existence (return 404, not 403).
- Every endpoint that touches claims needs a recipient test proving the surprise rule.
- Run `make test` before declaring any task done. Do not weaken, skip, or delete a failing authz test to get green; fix the code or ask.

## Model routing (Claude Code)

- **Main session: Sonnet.** Writes and edits application code.
- **Opus advisor:** consult before changing RLS policies, auth flows, token handling, or the authz matrix, and for the security review phase.
- **Haiku subagents** (`.claude/agents/`, `model: haiku`), read-only or low-risk work only:
  - `Explore` — find files, trace call paths, summarize code
  - `test-writer` — generate tests from the authz matrix
  - `docs` — README, Compose comments, docstrings, UI copy
  - `test-runner` — run the suite and summarize failures
- Haiku subagents must not edit files under `apps/*/permissions.py`, `apps/*/policies/`, migrations containing RLS, or `settings/security.py`.
- After a session, spot-check `~/.claude/projects/<project>/<session>/subagents/` logs to confirm subagents ran on the intended model.

## Working style

- Small, focused changes. One feature or fix per PR.
- Never edit an applied migration; add a new one.
- Ask before adding dependencies, changing the matrix, or touching anything in "Security non-negotiables."
