# Unwrapped — Cheerful, Privacy-First Family Wish List App

**Unwrapped** is a self-hosted, invite-only gift wish list platform designed for multiple families to share on a single deployment. Givers coordinate purchases, split big gifts with group pledges, and assign shopping tasks to relatives — all while strictly guaranteeing that a list's recipient never learns what has been bought, pledged, or assigned until after the event.

Designed with a refined warm look (pine green primary, a sparing cranberry accent, warm paper neutrals, self-hosted Fraunces and Inter fonts, an SVG icon set, and a sidebar or bottom-tab navigation with hash routes), **Unwrapped** prioritizes both rigorous security and effortless usability for older, less technical relatives.

---

## Highlights & Security Architecture

### 1. Multi-Family Isolation Enforced at Two Layers (App + PostgreSQL RLS)
- Multiple families share one deployment in complete isolation.
- Every family-scoped table (`family_members`, `invites`, `guest_links`, `assignment_links`, `lists`, `images`, `items`, `claims`, `pledges`, `assignments`, `notifications`, `audit_logs`) enforces PostgreSQL **Row-Level Security (`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`)** bound to `current_setting('app.current_family_id', true)::uuid`.
- Cross-tenant requests always return `404 Not Found` (`{ error: "Not found" }`) identical to non-existent records.
- One person can belong to multiple families with a different role (`family_admin` or `member`) in each.

### 2. Content-Blind Instance Admin
- The Instance Admin can create and remove families and issue the initial Family Admin bootstrap invite, but is blocked at both the HTTP middleware layer and PostgreSQL role layer (`app_instance_admin` has `REVOKE SELECT` on all family content tables) from reading any family's wish lists, items, claims, pledges, assignments, or audit logs.

### 3. The Surprise Rule (Zero Information Leakage)
- A list's recipient never learns claim, pledge, or assignment state — including giver names, counts, flags, item ordering, `updated_at` timestamps, or error messages — even if they inspect network traffic or hold `family_admin` privileges.
- Even in the Family Admin Audit Log (`/api/families/:familyId/audit-logs`), any claim, release, pledge, or assignment targeting the viewing admin's own wish list is automatically filtered out.
- If a recipient edits or deletes an item that someone has already claimed, the edit/delete succeeds normally for the recipient with zero indication it was claimed, while notifying the claimer automatically.
- **After the Event**: The list owner can reveal **Thank-You Mode** to see who gave what and check off thank-you notes.

### 4. Invite-Only Sign-In, Passkeys, 2FA, & Assisted Enrollment
- **No public sign-up**: A Family Admin invites a specific email address using a single-use token (hashed with SHA-256 at rest, 7-day expiry).
- **Google Sign-In**: Supported when the Google account has a verified email matching the invite.
- **Local Accounts**: Require either a **Passkey (WebAuthn)** or **TOTP 2FA** before accessing family data, and issue 8 single-use **Recovery Codes**.
- **Admin-Assisted Enrollment & Recovery**: Family Admins can generate a one-tap link/QR code for less technical relatives so they can enroll a Passkey and sign in effortlessly.

### 5. Zero-Footprint Guest & Assignment Links
- One personal, long (256-bit) unguessable link per person, hashed with SHA-256 at rest, revocable in one tap, with a maximum lifetime of 365 days.
- Visiting `/g/:token` or `/a/:token` immediately exchanges the token for an `HttpOnly; SameSite=Lax; Secure` session cookie and issues a `303 See Other` redirect to `/guest` or `/assignment` with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Raw tokens never sit in the browser address bar, history, or redacted server logs.
- **Privacy by default**: Guests only ever see the **first names** of other people.
- Easy delivery via text message (`sms:`), iOS Share Sheet (`navigator.share`), or printable QR code.

### 6. SSRF-Safe Product URL Auto-Fill & Image Sanitization
- Pasting a product URL offers to auto-fill item name, price, image, and store name.
- **SSRF Protection**: Restricted to authenticated members, rate-limited, validates DNS across every redirect hop (max 3 hops), blocks all private, loopback, link-local, CGNAT, and cloud metadata (`169.254.169.254`) IPv4/IPv6 ranges, and enforces strict timeout (5s) and response size (1 MB HTML, 5 MB image) caps.
- **Image Sanitization**: Uploaded and fetched images are validated, resized, re-encoded to WebP via `sharp`, and stripped of all EXIF, GPS, ICC, and XMP metadata.

### 7. Group Gifting, Assignments, Static Shopping Cards & Offline Support
- **Claiming Prompts**: Tapping a store link on an available item asks *"Are you getting this?"* (and asks again on future visits if they tap *"Just looking"*). Claimed items move into a collapsed *"Already taken"* section showing *"Taken by [First Name]"* and ask *"Buy anyway?"* before opening store links.
- **Group Gifting**: Multiple givers can pledge toward an expensive item with a visual progress bar.
- **Assignments & Static Shopping Cards**: Members can assign items to a relative (claiming them immediately in that person's name), track status (`assigned`, `bought`, `couldn't get it`), receive reminders 5 days before the event, and generate a static **Offline Shopping Card** in **PDF** and **PNG** formats to share via the iOS Share Sheet.
- **Offline Sync**: Guest and assignment views cache a read-only copy via Service Worker, and offline *"Bought"* / claim taps queue locally and sync automatically on the next online visit.

---

## Quick Start

### 1. Run Locally (Development & Automated Tests)
Unwrapped includes an in-process PostgreSQL engine (`@electric-sql/pglite`) with full PostgreSQL Row-Level Security and role enforcement for zero-config local development and testing:

```bash
npm install
npm test          # Runs the 56-test security & integration suite
npm run dev       # Starts server at http://localhost:3000
```

### 2. Run in Production with Docker Compose & Automatic HTTPS
The `docker-compose.yml` stack pulls `ghcr.io/jray222/unwrapped:latest` (`pull_policy: always`, built and published by GitHub Actions on every merge to `main` and whenever `node:22-bookworm-slim` updates via `base-image-update.yml`) alongside PostgreSQL 16 and Caddy for automatic HTTPS:

```bash
cp .env.example .env
# Edit .env to set SESSION_SECRET, BOOTSTRAP_INSTANCE_ADMIN_TOKEN, and POSTGRES_PASSWORD
docker compose up -d
```

To build the image from your local checkout instead of pulling from GHCR:
```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```
- **HTTP**: `http://localhost:38180`
- **HTTPS**: `https://localhost:38443`

For architecture details, database RLS policies, and LLM continuation instructions, see [AGENTS.md](./AGENTS.md).
