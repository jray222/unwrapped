# AGENTS.md — Unwrapped v2 Architecture & LLM Handoff Guide

> **Purpose of this file**: This document is the single source of truth for any LLM or developer picking up work on **Unwrapped v2** (the self-hosted, invite-only, multi-family wish list app). Always update both `AGENTS.md` and `README.md` whenever modules, schemas, routes, or status change.

---

## 1. Current Project Status

- **Phase**: Complete, Verified, & Deployed (`47/47` Vitest + Supertest integration & security tests passing; `tsc --noEmit` 0 errors; Docker production image & GitHub Container Registry pipeline active).
- **Completed Modules**:
  - [x] **Module 1 — Database Layer & PostgreSQL Row-Level Security (`src/db/index.ts`, `src/db/schema.sql`)**:
    - Dual PostgreSQL engine (`pg.Pool` for Docker/PostgreSQL 16 and `@electric-sql/pglite` for zero-config local/test execution).
    - Strict PostgreSQL roles (`app_tenant` with `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on all 11 family-scoped tables, and `app_instance_admin` with `REVOKE SELECT` on all family content tables).
  - [x] **Module 2 — Security Primitives, Auth, Passkeys, 2FA, Recovery Codes, Google OIDC, CSRF & Sessions (`src/security/`, `src/routes/auth/`, `src/routes/links.ts`)**:
    - `scrypt` password hashing, `SHA-256` token hashing at rest for all invite, guest, assignment, session, and recovery tokens.
    - Mandatory 2FA (TOTP via `otplib`) or Passkey (`@simplewebauthn/server`) enrollment for local accounts, with 8 single-use recovery codes.
    - Admin-Assisted Enrollment & Recovery links (`/assisted/:token` -> `/api/auth/assisted-enroll`) for one-tap passkey onboarding of less technical relatives.
    - Zero-footprint token exchange routes (`/g/:token`, `/a/:token`, `/invite/:token`, `/assisted/:token`) using `HttpOnly; SameSite=Lax; Secure` cookies, `303 See Other` redirects, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and server log token redaction.
  - [x] **Module 3 — SSRF-Safe Auto-Fill, Image Sanitization, & Shopping Cards (`src/services/`)**:
    - `ssrf-autofill.ts`: Blocks all private/loopback/link-local/CGNAT/cloud-metadata IPv4 and IPv6 addresses across DNS resolution and manual redirect hops (max 3 hops), enforces 5s timeout and 1 MB HTML limit, and parses product metadata via `cheerio`.
    - `image-sanitizer.ts`: Validates image buffers, resizes within 800x800, re-encodes to clean WebP via `sharp`, and strips all EXIF/GPS/XMP/ICC metadata.
    - `shopping-card.ts`: Generates static offline Shopping Cards in both **PDF** (`pdfkit`) and **PNG** (`sharp` SVG rasterization) formats with zero embedded credentials.
  - [x] **Module 4 — Core API Routes (`src/routes/instance-admin.ts`, `src/routes/family-admin.ts`, `src/routes/lists-items/`, `src/routes/gifts/`)**:
    - Content-blind Instance Admin API, Family Admin member/role/invite/guest-link/audit-log management, Lists & Items with catch-all item and price filters, Claiming & Group Gifting Pledges, Assignments with status tracking & 5-day pre-event reminders, Post-Event Thank-You Mode reveal, and Offline Sync (`POST /api/offline/sync`).
  - [x] **Module 5 — Cheerful Winter Holiday Accessible SPA & Offline Service Worker (`public/`)**:
    - Cozy winter & holiday theme (`#FAF7F2` snow cream, `#1B4332` evergreen pine, `#9B2226` cranberry red, `#D97706` gold ribbon) with `18px` base text and `52px+` touch targets.
    - Full strict CSP compliance (`script-src 'self'`), offline action queue (`localStorage.unwrapped_offline_queue`), Service Worker caching (`public/sw.js`), iOS Share Sheet (`navigator.share`), and pure-JS printable QR codes.
  - [x] **Module 6 — Docker, Caddy Automatic HTTPS, CI/CD & Verification Suite (`Dockerfile`, `docker-compose.yml`, `.github/workflows/docker-image.yml`, `tests/*.test.ts`)**:
    - Multi-container production stack (`db` PostgreSQL 16 + `app` Node 22 + `caddy` automatic HTTPS on ports `38180` HTTP / `38443` HTTPS).
    - 47 end-to-end security and functional tests in `tests/01-…08-*.test.ts` (shared setup in `tests/helpers/fixtures.ts`).

---

## 2. Core Architectural Invariants (MUST NEVER BE VIOLATED)

1. **Two-Layer Tenant Isolation (App + PostgreSQL Row-Level Security)**:
   - Every family-scoped table (`family_members`, `invites`, `guest_links`, `assignment_links`, `lists`, `images`, `items`, `claims`, `pledges`, `assignments`, `notifications`, `audit_logs`) has `family_id UUID NOT NULL` and PostgreSQL `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.
   - Every tenant query executes inside `withFamilyContext(familyId, callback)` which runs `SET LOCAL ROLE app_tenant` and `SELECT set_config('app.current_family_id', $1, true)` inside a transaction.
   - Cross-family requests MUST return `404 Not Found` (`{ error: "Not found" }`) identical to non-existent resources.

2. **Instance Admin Content Blindness**:
   - The `instance_admin` role can create/list/remove families (`families` table) and generate the bootstrap invite for a family's initial admin.
   - Instance admins are blocked at both the route/middleware layer AND database role layer (`app_instance_admin` DB role has no `SELECT` permission on `lists`, `items`, `claims`, `pledges`, `assignments`, `audit_logs`) from reading any family content.

3. **The Surprise Rule (Zero-Leakage Recipient Protection)**:
   - When the viewer of a list or item is its recipient (`list.recipient_user_id === currentUser.id`) and `list.thank_you_revealed === false`:
     - The API response MUST NOT include `claims`, `pledges`, `assignments`, `claimed_count`, `total_pledged_cents`, `is_taken`, or any giver names/counts/flags.
     - Item ordering MUST always be deterministic (`created_at ASC, id ASC`) and never depend on claim/pledge status.
     - Claiming, releasing, pledging, or assigning an item MUST NEVER touch `items.updated_at` or `lists.updated_at`.
     - If the recipient edits or deletes a claimed/pledged/assigned item, the edit/delete succeeds normally with zero indication that it was claimed, while creating a notification in `notifications` for all affected givers.
     - If the recipient is also a `family_admin`, `GET /api/families/:familyId/audit-logs` filters out all `is_surprise_sensitive = true` events targeting lists where `recipient_user_id = currentUser.id` (unless `thank_you_revealed = true`).

4. **Secret Token Handling**:
   - All invite tokens, guest link tokens, assignment link tokens, session tokens, assisted-enrollment tokens, and 2FA recovery codes are hashed with `SHA-256` (or `scrypt` for passwords) at rest. Raw tokens are never stored in the database.
   - Visiting `/g/:token`, `/a/:token`, `/invite/:token`, or `/assisted/:token` immediately exchanges the token for an `HttpOnly; SameSite=Lax; Secure` cookie and issues a `303 See Other` redirect to a clean URL (`/guest`, `/assignment`, `/?mode=invite`, `/?mode=assisted`) with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Server logs scrub token paths (`/g/[REDACTED]`).

5. **SSRF-Safe URL Auto-Fill & Image Sanitization**:
   - Only authenticated `member` / `family_admin` users can call `/api/families/:familyId/autofill`.
   - URL fetcher validates protocol (`http:` / `https:`), ports (`80`, `443`), resolves DNS on every hop (manual redirects, max 3 hops), rejects all private/loopback/link-local/CGNAT/cloud-metadata IPv4 & IPv6 ranges, enforces a 10s timeout and byte limits (HTML is truncated at 1 MB and parsed from the part read; images are rejected over 5 MB), uses an honest `Unwrapped/2.0` User-Agent (never impersonates a browser), and reports bot-check/captcha pages as a clear error.
   - Images (uploaded or fetched) are decoded and re-encoded via `sharp` into clean WebP buffers, stripping all EXIF/ICC/XMP metadata.

---

## 3. Directory Structure & File Ownership

```text
unwrapped/
├── AGENTS.md                        # LLM handoff & architectural invariant guide
├── README.md                        # Setup, deployment, security, and API documentation
├── Dockerfile                       # Production container (target: prod)
├── docker-compose.yml               # Production stack pulling ghcr.io/jray222/unwrapped:latest (pull_policy: always)
├── docker-compose.build.yml         # Local build override (docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build)
├── Caddyfile                        # Standalone Caddy reverse proxy config
├── .env.example                     # Template for environment variables (no secrets in repo)
├── .github/workflows/
│   ├── docker-image.yml             # CI test + Docker smoke-test + multi-arch GHCR build/push with GHA cache & base-digest label
│   └── base-image-update.yml        # Daily 09:00 UTC check for node:22-bookworm-slim base image updates
├── package.json                     # Dependencies and scripts
├── tsconfig.json                    # TypeScript configuration
├── src/
│   ├── types.ts                     # Shared TypeScript interfaces & domain models
│   ├── config.ts                    # Environment config & defaults
│   ├── db/
│   │   ├── index.ts                 # Dual PostgreSQL driver (pg Pool + PGlite) & RLS helpers
│   │   └── schema.sql               # Full DDL, roles, and Row-Level Security (RLS) policies
│   ├── security/
│   │   ├── crypto.ts                # SHA-256 token hashing, scrypt passwords, TOTP, recovery codes
│   │   ├── middleware.ts            # Session auth, CSRF guard, rate limiters, CSP, log redaction
│   │   └── surprise.ts              # Surprise Rule serializer & guest first-name redactor
│   ├── services/
│   │   ├── ssrf-autofill.ts         # SSRF-safe URL fetcher, IP validator, HTML metadata parser
│   │   ├── image-sanitizer.ts       # sharp image validation, re-encoding, and EXIF stripping
│   │   ├── shopping-card.ts         # Offline Shopping Card generator (PDF via pdfkit & PNG via sharp)
│   │   └── …                        # Business logic extracted from routes (claims, pledges, assignments, sessions, mfa, passkeys, google-auth, offline-sync, …)
│   ├── routes/
│   │   ├── auth/                    # session, invite, totp, passkeys, google, assisted (index.ts mounts them)
│   │   ├── instance-admin.ts        # Instance admin family creation/deletion (content-blind)
│   │   ├── family-admin.ts          # Members, roles, invites, guest/assignment links, audit logs
│   │   ├── lists-items/             # lists, items, autofill, images, thank-you reveal
│   │   ├── gifts/                   # claims, pledges, assignments, shopping cards, views, offline sync
│   │   └── links.ts                 # Clean URL token exchange (/g/:token, /a/:token, /invite/:token)
│   ├── errors.ts                    # HttpError (status-carrying error used across routes/services)
│   ├── app.ts                       # Express app assembly
│   └── server.ts                    # HTTP server entrypoint
├── public/
│   ├── index.html                   # Cheerful winter holiday, large-text mobile-first UI
│   ├── styles.css                   # Accessible styling (18px+ base font, 52px+ tap targets, print styles)
│   ├── js/                          # Native ES modules; main.js is the entry (state, api, session, lists, items, gifts, assignments, offline, passkeys, …)
│   ├── sw.js                        # Service Worker for offline caching of guest/assignment views
│   ├── manifest.json                # Web App Manifest
│   └── icon.svg                     # Festive gift app icon
└── tests/
    ├── 01…08-*.test.ts              # 47-test end-to-end & security verification suite, split by section
    └── helpers/fixtures.ts          # Shared test setup
└── e2e/
    └── smoke.spec.ts                # Playwright browser smoke test (login + 2FA, list, item, autofill wiring)
```

---

## 4. Common Developer & LLM Commands

- **Run full test suite (47 tests)**: `npm test`
- **Run browser smoke tests (Playwright, needs `npx playwright install chromium` once)**: `npm run test:e2e`
- **Run TypeScript typecheck**: `npm run build`
- **Start local development server**: `npm run dev` (listens on `http://localhost:3000`)
- **Build production Docker image**: `docker build --target prod -t ghcr.io/jray222/unwrapped:latest .`
- **Start production Docker Compose stack (pulls from GHCR)**: `docker compose up -d` (HTTP on `http://localhost:38180`, HTTPS on `https://localhost:38443`)
- **Start Docker Compose stack built from local checkout**: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`
