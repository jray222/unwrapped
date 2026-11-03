# Unwrapped UI Overhaul: Refined Warm look + Sidebar Navigation

> **Immediate step (once approved):** copy this plan to `TODO.md` at the repo root. Then `git checkout main` (the repo is on a detached HEAD at 6f24bde with a clean tree), `git pull`, commit only `TODO.md` as "docs: add UI overhaul TODO" with the Co-Authored-By line, and `git push origin main`. Stop there. The implementation phases below wait for a separate go-ahead.

## Context
The SPA (`public/`) works but looks amateur. Here is why:
- **The nav is weak.** The header holds 5 emoji buttons (`🎁 Wish Lists`, `🚪 Sign Out` in red), a gold-bordered `<select>` and a "Cozy" badge, all in one `flex-wrap` row (`public/index.html:29-53`). On phones it wraps into a messy block. There's no back-button support, the current family and list aren't clear, and Sign Out sits next to the main destinations.
- **The visuals compete with each other.** Three accent colors (pine, cranberry, gold) are all used for primary actions. There are gradient buttons, ribbon-corner triangles, dashed borders, and emoji in nearly every heading and button. It uses the system font with 800-weight headings.
- **The code is ad hoc.** About 60 inline `style=""` attributes in `index.html`, plus ~135 `innerHTML`/`style.` writes in `public/js/*` (the toast in `ui.js:9-14` is styled inline, for example).
- **The copy exposes internals** ("hashed at rest", "PostgreSQL", "zero-footprint", `app_instance_admin`).

Your choices: **Refined warm** (one primary color, a sparing accent, a real display font, SVG icons, flat buttons, works all year) and a **sidebar on desktop** with lists nested under the family, plus **bottom tabs on phones**.

Constraints we keep:
- CSP `script-src 'self'` and `font-src 'self' data:` (`src/security/middleware.ts:37-52`), so fonts and icons must be self-hosted.
- 18px base text and 52px tap targets (AGENTS.md Module 5).
- Offline SW shell.
- The Surprise Rule: this is styling only. Rendering never adds claim state for recipients, and item order stays as the server returns it.
- No backend changes.

## Acceptance checklist: the 4 problems this overhaul must fix
1. **Weak nav: fixed when**
   - The main destinations (Lists, Shopping, Share, Family) sit in a sidebar on desktop and a bottom tab bar on phones. Nothing wraps at 390px.
   - The current family and the active list are always visible, marked with `aria-current="page"`.
   - Sign out is only in the avatar menu, not next to the main destinations.
   - The browser back and forward buttons and deep links (`#/lists/:id`, `#/shopping`, `#/share`, `#/family`) all work.
   - Guest, assignment, auth and instance-admin views use the minimal shell.
2. **Competing visuals: fixed when**
   - Pine is the only primary-action color. Cranberry is only for "Really want" tags, destructive actions and small highlights. Gold is gone from the UI.
   - No gradients, ribbon corners or dashed borders remain in `styles.css`.
   - No emoji appear in the chrome (headings, buttons, nav). SVG sprite icons replace them.
   - Headings use Fraunces and UI text uses Inter, both self-hosted.
3. **Ad hoc code: fixed when**
   - `index.html` has no `style="` attributes.
   - JS sets inline styles only for dynamic values (for example the pledge bar width). Show/hide uses classes or the `hidden` attribute, and the toast uses the `.toast` class.
   - Every color, space and radius comes from `:root` tokens.
   - Check: `grep -c 'style="' public/index.html` returns 0, and `grep -n '\.style\.' public/js` shows only dynamic values.
4. **Internals in the copy: fixed when**
   - User-facing text no longer mentions PostgreSQL, hashing, `app_instance_admin`, "zero-footprint", SSRF or token internals.
   - Headings are sentence case.
   - The content-blind policy note in instance admin becomes one plain sentence ("You can manage families but can't see their lists or gifts.").
   - Check: `grep -inE 'postgres|hashed|zero-footprint|app_instance|ssrf' public/` returns no user-facing strings.

## Design system (Phase 1)
- **Tokens** (rewrite `:root` in `public/styles.css`):
  - Neutrals: warm paper `#FBF8F3`, surface `#FFFFFF`, ink `#1F2A24`, muted `#5B6660`, hairline `#E7E1D6`.
  - Primary: pine `#1E4D3A` with hover and soft tints.
  - One accent: cranberry `#A3242B`, used only for "Really want" tags, destructive actions and small highlights. Gold goes away as a UI color.
  - A spacing scale (4/8/12/16/24/32/48), radii (8/12/16), and 2 soft shadows.
- **Type**: self-host 2 OFL variable fonts in `public/fonts/` (`.woff2`): **Fraunces** for headings (warm serif) and **Inter** for UI and body. Add `@font-face` with `font-display: swap`. Headings use weights 600/650 with tighter tracking.
- **Icons**: add `public/icons.svg`, an SVG `<symbol>` sprite of about 20 Lucide-style line icons (gift, list, shopping-bag, share, users, plus, chevron, more, external-link, check, lock, log-out, qr, printer, x, sparkles, calendar, filter). Use them via `<svg class="icon"><use href="/icons.svg#gift"/></svg>` (same origin, CSP-safe). Add an `icon(name)` helper in `public/js/ui.js` for JS-rendered markup. Remove all emoji from the chrome.
- **Components** (classes in `styles.css`; strip every inline style from `index.html` into them):
  - `.btn` with variants primary, secondary, ghost, danger and sizes sm/md (md stays 52px). Flat, no gradients.
  - `.field`/`.input`, `.card`, `.tag`, `.segmented` (price filter), `.empty-state`, `.toast` (replacing the inline styles in `ui.js:showToast`), `.menu` (avatar/overflow dropdown), `.avatar` (initials).
  - Modals become **bottom sheets on phones** (<640px) and centered dialogs on desktop. Keep the existing `openModal`/`closeActiveModal` API in `ui.js`. Add Esc and backdrop-click close plus a focus return if they're missing.

## App shell & navigation (Phase 2)
New layout in `index.html`: `<div class="app-shell">` holds `<aside id="app-sidebar">`, `<header id="app-topbar">`, `<main>` and `<nav id="app-tabbar">`.

- **Desktop (≥960px), fixed 272px sidebar:**
  1. Brand mark (SVG gift plus the "Unwrapped" wordmark in Fraunces).
  2. **Family switcher**: a styled button showing the family name and a chevron that opens a menu. It keeps `#family-selector` as the underlying source of truth, or replaces it and updates the listener in `listeners-auth.js:32`.
  3. **Wish lists** section: each list is a nav row (recipient avatar initial, list name, recipient name muted, active state = tinted background plus a pine left bar), followed by a "+ New list" ghost row (opens `modal-create-list`).
  4. Shopping, Share, Family (admin only, same visibility logic as `#nav-admin`).
  5. Footer: user avatar and name, opening a menu with Security (2FA/passkey) and Sign out. Sign out leaves the main nav.
- **Phone (<960px):** a slim top bar (family name as the switcher, avatar menu on the right) and a fixed **bottom tab bar** with 4 icon+label tabs: Lists, Shopping, Share, Family. On the Lists tab, the lists show as a horizontally scrolling chip row at the top of the page (`#lists-tabs-bar`, so the e2e check still holds).
- **One list renderer:** `renderListsTabs()` in `public/js/lists.js` renders into both `#sidebar-lists` and `#lists-tabs-bar` from the same data. It also fixes the active check, which currently compares `state.currentList.id` before `currentList` updates; use `state.currentListId`.
- **Hash routing** (fixes back button and deep links): `#/lists/:id`, `#/shopping`, `#/share`, `#/family`. Add a small `router.js`:
  - It maps routes to the existing loaders (`selectWishList`, `loadAssignmentsView`, `loadShareLinksView`, `loadFamilyAdminView`).
  - `showView()` in `ui.js` sets the `aria-current="page"` active state on the sidebar and tab items instead of the hard-coded `nav-*` ids at `ui.js:57-61`.
  - Nav clicks set `location.hash`, and a `hashchange` listener drives the views.
  - Guest (`/guest`), assignment (`/assignment`), auth and instance admin views keep a **minimal shell** with no sidebar or tabs (toggle a `body[data-shell="app|minimal"]` attribute where `session.js:217` currently toggles `#header-user-controls`).
- The offline banner becomes a slim bar inside the shell. The notification bar becomes a stacked card list under the page header.

## Pages (Phase 3–4)
- **Wish list page** (`view-dashboard`):
  - **Header:** list name in Fraunces, then "For {recipient} · {event date, 'in 12 days'}", then the item count.
  - **Actions:** primary **Add item**, secondary **Share**, and an overflow menu (Reveal givers when that applies).
  - The price filter becomes a compact segmented control.
  - The Surprise banner becomes a quiet single-line notice with a lock icon. The Reveal box becomes a card with one action.
  - **Add item** moves from the `<details>` accordion to a side sheet (bottom sheet on phones). It has the auto-fill URL field at the top and the fields in two columns on desktop. Keep all field ids.
  - **Item cards** (`createItemCard` in `public/js/items.js`):
    - A responsive grid (1 column on phone, 2 on tablet, 3 on desktop).
    - A fixed 4:3 image area, with a soft tinted icon placeholder when there's no image.
    - Name, then price · store, then a tag row (Really want / Qty / Duplicates OK).
    - Pledge progress as a thin bar.
    - One primary action (Claim/Release) plus an overflow menu (Pledge, Assign, Open store).
  - "Already taken" becomes a plain collapsible section with a count.
- **Shopping** (`assignments.js`): a checklist-style list (checkbox-feel "I bought this", item, for whom, store link). Shopping Card PDF/PNG buttons go in the page header.
- **Share** (`share-links.js`): a two-column layout on desktop (create form | existing links). Link rows show the name, created date and icon actions (copy, share, QR, revoke).
- **Family** (`admin.js`, `listeners-admin.js`):
  - Tabs inside the page: Members | Invites | Activity.
  - Members table with avatar and role tag. Invite and Assisted-setup forms sit in cards.
  - The audit log is restyled and no longer says "PostgreSQL".
- **Auth** (`view-auth`): a centered card on a warm paper background with a subtle brand illustration (inline SVG, no emoji). Passkey stays the primary button, then Google, then email/password. Invite redeem and the server-admin link become quiet text links.
- **Guest / Assignment / Instance admin**: the same components in the minimal shell.
- **Copy pass:** remove the internals jargon and the emoji. Use sentence-case headings ("Share lists", not "🔗 Share Wish Lists With Family & Guests").

## Polish (Phase 5)
- Empty states (no lists, no items, no assignments) with an icon, a sentence and a single action. Replace `renderEmptyListState` in `lists.js`.
- Skeleton loading cards while lists and items load.
- Toast restyled at the bottom center (above the tab bar on phones), with `role="status"`.
- `prefers-reduced-motion` respected. Visible focus rings in the pine tint.
- Print styles updated for the new shell (hide sidebar and tab bar).
- `public/sw.js`: add `/js/router.js`, `/icons.svg` and `/fonts/*.woff2` to `STATIC_SHELL_URLS`, extend the asset match to `.woff2`, and bump `CACHE_NAME` to `-v5`.
- `manifest.json`/`theme-color` updated to the new pine.
- Update `AGENTS.md` and `README.md` (Module 5 description, file list), as AGENTS.md requires.

## Critical files
- `public/index.html` (restructured shell, inline styles removed, ids preserved where JS and tests use them)
- `public/styles.css` (full rewrite around the tokens and components)
- `public/js/ui.js` (`showView`, toast, `icon()`, menus), new `public/js/router.js`, `public/js/session.js` (shell toggle and family switcher), `public/js/lists.js`, `public/js/items.js`, `public/js/listeners-*.js`, `assignments.js`, `share-links.js`, `admin.js`, `guest.js`
- New `public/icons.svg` and `public/fonts/` (Fraunces and Inter woff2, OFL license file included)
- `public/sw.js`, `e2e/smoke.spec.ts`

## Verification
1. `npm run build` (tsc) and `npm test`: all 47 must still pass. The backend is untouched, so this guards against accidental changes.
2. Update `e2e/smoke.spec.ts`: the add-item step opens the sheet via the new **Add item** button instead of `#accordion-add-item > summary`. Add nav checks: click the sidebar Shopping item, assert `#view-assignments` is visible and the URL hash is `#/shopping`, go back, assert the dashboard is visible. Run `npm run test:e2e`.
3. Run `npm run dev` and screenshot with Playwright at **390×844** and **1280×800** for auth, dashboard (as giver and as recipient), add-item sheet, shopping, share, family and guest. Confirm:
   - no horizontal scroll and no CSP errors in the console;
   - the recipient view shows no claim, pledge or taken UI;
   - tab order and focus work through the sidebar, menus and sheets;
   - offline: toggle offline in DevTools and confirm the shell, fonts and icons load from the SW cache.
4. Go through the **Acceptance checklist** above item by item and run its grep checks. Report each of problems 1–4 as fixed, or name what's still open.
