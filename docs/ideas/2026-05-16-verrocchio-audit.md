# Verrocchio — Engineering Audit

**Auditor:** Claude (Opus 4.7, 1M ctx)
**Repo:** `/Users/maxwellcollins/Developer/verrocchio`
**Branch:** `main` @ `72b9c93` (clean)
**Date:** 2026-05-16

---

## 1. What it is

Verrocchio is a single-file (~1.5 MB / 30,002-line) React PWA habit + goal + journal tracker, backed by Firebase (Auth, Firestore, Storage, Hosting) and a Cloudflare Worker AI proxy. The web build is the same `index.html` wrapped in a Capacitor iOS shell for App Store distribution. The product is positioned as a "serious, classical, craft-focused" antidote to gamified habit apps — named after the Renaissance master who trained Leonardo da Vinci. Aimed at self-directed adults 25–55 who already practice some daily discipline and have churned off Streaks/Habitica/Todoist/Notion (`docs/MARKETING_LANDING_BRIEF.md:25-50`).

The app surfaces five tabs (`index.html:30000+` tab nav):

- **Brief** — daily ritual / morning briefing surface, AI debrief in v1.1, plus tips/streak/yesterday pills.
- **Habits** — daily/weekly/monthly habits grouped by section (morning/afternoon/evening/avoid). Multi-slot habits, per-slot completion times, drag-to-reorder via SortableJS (`index.html:5074`), 14-day grids, streak math in `utils.js`.
- **Todos** — urgent-todo list with due dates and staleness filtering.
- **Reflection** — journaling (multiple tags: gratitude, wins, challenges, ideas), past entries filtering, AI insights generator that ships disabled (`AI_ENABLED = !!AI_BACKEND_URL` is currently true but the UI is gated by `AI_BACKEND_URL`).
- **Goals** — SMART-framework goals (specific/measurable/achievable/relevant/timebound), linked to parent habits, with Area-of-Life groupings and a Future Goals drawer.

The monetization model (`docs/MONETIZATION_V1.md`) is a 7-day free trial → caps-based free tier → referral-unlock ladder (3 invites → 30-day expansion, 5 → permanent, planned 10/25/50 → Pro). Apple StoreKit + receipt validation deferred to v1.x. Grandfather flag on every v1 account.

Project age: **433 commits across ~5 months** of intense iteration (initial uploads as zip drops; substantive work starts mid-Feb 2026 per `git log --reverse`). Latest commit 2026-05-16. SHELL_VERSION currently `v70` — that is, **70 production deploys of the SW shell**.

---

## 2. Architecture

### 2.1 Frontend

Single `index.html` of 30,002 lines / 1.48 MB containing:

- All CSS (~3000 lines of tokenized + legacy-rgb-override design system, `:root` at `index.html:105`, dark-mode substring overrides).
- All app JS as one `<script>` block. **No JSX, no build step** — React is loaded UMD from unpkg with SRI hashes pinned (`index.html:31-32`), and the inline code uses `React.createElement()` directly. Grep counts: **2,228 createElement calls, 370 onClick handlers, 305 hook invocations, 1 `function App()` mega-component** at `index.html:3723` that spans roughly lines 3723–29900.
- One `ErrorBoundary` class at `index.html:3690` wraps `<App />`. Global `window.error` + `unhandledrejection` listeners write last-error to localStorage at `index.html:1100-1113`.
- 11 helper files are factored OUT of the inline blob into `lib/*.js` (auth 221 LOC, dialog 128, hydration 275, icalendar 242) plus `utils.js` (379 LOC). These were Phase-2 "OSS-port" extractions, each pinned by Node tests. This is the only modularity inside the codebase, and it's the right move — they're small, pure-ish, and test-covered.

State management: ~305 `useState`/`useRef`/`useReducer` calls all inside the single `App()` component. There is one cloud-data ref (`latestData.current`, `index.html:7234`), a `lastSaveRef` for retry parking, and `localStorage` for offline mirroring. Save path is fire-and-forget Firestore `set()` with `sanitizeForFirestore` (`index.html:7486`) that strips undefined / circular / non-cloud-safe fields. `enablePersistence({synchronizeTabs:true})` at boot (`index.html:1125`) gives offline IndexedDB mirror.

The codebase is consciously single-blob — `.claude/CLAUDE.md` calls it "single-file PWA invariant." That's a coherent choice for shipping a static asset without a bundler, but it has costs (§4).

### 2.2 Backend

Firebase only. No custom server other than the AI proxy. The Firestore data model is implicit (no schema file) but emerges from `firestore.rules`:

```
service cloud.firestore {
  match /users/{userId} {
    allow read, write: if request.auth != null && request.auth.uid == userId;
    match /{document=**} { allow read, write: if same; }
  }
  match /{document=**} { allow read, write: if false; }
}
```

**Verdict: tight, owner-scoped, default-deny.** Each user's entire workspace lives at `users/<uid>` as a single document plus arbitrary nested subcollections, all gated by `request.auth.uid == userId`. There is no admin override, no public read, no shared collection. Cross-user reads are structurally impossible. The same pattern in `storage.rules`: `users/<uid>/content/<fileName>`, owner-only, plus a 10 MB size cap on write.

`firebase.json` ships solid security headers: HSTS 1y/includeSubDomains, X-Content-Type-Options nosniff, strict-origin-when-cross-origin Referrer-Policy, Permissions-Policy locking down geolocation/camera/microphone (`firebase.json`). Static assets get `Cache-Control: public, max-age=31536000, immutable`; the SW gets `no-cache, no-store, must-revalidate`.

### 2.3 AI proxy

`ai-proxy/worker.js` (147 LOC) is a Cloudflare Worker doing four things:

1. CORS allowlist for `verrocchio.app`, the `*.web.app`/`*.firebaseapp.com` fallbacks, and `capacitor://localhost` (`worker.js:87-92`).
2. Firebase ID-token verification via `jose` (`jwtVerify` + `createRemoteJWKSet` from Google's published JWKS) with `issuer/audience/algorithms:["RS256"]` enforced (`worker.js:136-144`).
3. Model + max_tokens allowlist — only `claude-sonnet-4-20250514` and `claude-haiku-4-5-20251001`, max_tokens hard-capped to 2000 (`worker.js:25-29, 60-62`).
4. Anthropic key in a Wrangler secret (`wrangler.toml`: "ANTHROPIC_API_KEY is provisioned as a secret — DON'T put it here"). Tests at `ai-proxy/tests/` cover wrong-key + alg:none rejection paths.

**Verdict: the proxy is well-engineered for a 147-line Worker.** Key on the server, JWT verified, model+token clamps. The only material gap is **no rate limit per user** — see §3 P1.

### 2.4 Mobile

`capacitor.config.json` minimal:

```json
{ "appId": "com.verrocchio.app", "appName": "Verrocchio", "webDir": "dist",
  "server": { "iosScheme": "capacitor" },
  "ios": { "contentInset": "always", "limitsNavigationsToAppBoundDomains": false } }
```

No `server.url` set — the app is bundled, not loading from a remote URL. That's correct. `limitsNavigationsToAppBoundDomains:false` is permissive but is the Capacitor default and matters mostly for service-worker scope. `ios/` contains `PrivacyInfo.xcprivacy`, `AppIcon.appiconset/`, `ExportOptions.plist` with `{{TEAM_ID}}` placeholder — the actual Xcode project is generated at build time by `cap add ios`.

### 2.5 Service worker

`service-worker.js` is **Workbox-driven** (108 LOC) since Port #5. `SHELL_VERSION = "v70"` is the single source of truth for cache versioning (`service-worker.js:25`). Routes: same-origin navigations → network-first, same-origin GETs → cache-first, allowlisted CDNs (unpkg/jsdelivr/gstatic/esm.sh) → stale-while-revalidate, apex `/` bypassed so Firebase Hosting's `302 /home` survives. `activate` handler runs `precaching.cleanupOutdatedCaches()` AND iterates `caches.keys()` to delete legacy `verrocchio-*` caches whose name doesn't end with current `SHELL_VERSION`. Localhost dev (non-webdriver) skips SW registration entirely and purges stale caches (`index.html:1204-1219`) — a hard-learned fix per the v70 commit log.

---

## 3. Security findings

### P0 — Critical

**P0-1. Demo password `verrocchio-demo-1` is in git history (CONFIRMED).**
Found commits introducing the literal across the codebase:

- `4a08ae5` "Add demo-user seed script for app-behavior dogfooding" — `const DEMO_PASSWORD = "verrocchio-demo-1";` in `scripts/seed-demo-users.mjs`.
- `85fb04e` "Sign-in: one-tap demo-persona buttons" — `await auth.signInWithEmailAndPassword(email, "verrocchio-demo-1");` directly in `index.html`.
- `f1ec9bb` "Wave 1: Foundation" REMOVED the literal but the diff itself, of course, immortalizes it.

The current source uses `%%DEMO_PASSWORD%%` substituted at build by `scripts/build-dist.mjs` from env (`scripts/build-dist.mjs:41-50`) — good. But **the literal will remain in `git log -p` forever** unless history is rewritten.

**Blast radius:** four `@demo.verrocchio.app` Firebase Auth accounts share that password. Anyone who clones the repo can sign in as those personas, write garbage data, lock the account by changing the password (`auth/wrong-password` would then prevent the persona button from logging in), or pivot to *any* email account if the password is reused there.

The app *does* allowlist demo persona emails before using the password (`isDemoPersonaEmail`, `lib/auth.js:70-73`, called at `index.html:4283`), so the leaked credential cannot be replayed against arbitrary emails inside Verrocchio's own UI. But Firebase Auth's REST API doesn't honor that allowlist — anyone with the password + email can `signInWithEmailAndPassword` from any client. The integrity of the four demo accounts is gone.

**Fix:** (1) rotate the four passwords in Firebase Console NOW; (2) update CI to inject `DEMO_PASSWORD` at build; (3) optionally `git filter-repo --replace-text` to rewrite history (acceptable only because the repo is small and the founder controls all clones); (4) better: delete the demo accounts and replace with proper App-Store-Review credentials provided in App Review Notes.

**P0-2. Public Firebase Web API key is in git AND in the live HTML (informational, not exploitable).**
`firebaseConfig.apiKey = "AIzaSyDqweiDzza1Jkk-Amppy9ZfMvhc8AHHC_k"` at `index.html:1115`. This is by design — Firebase Web SDK keys are not secrets; Firestore/Storage security rules are the actual enforcement. The rules ARE tight (§2.2). However, the key SHOULD be restricted in Google Cloud Console by HTTP-referrer + iOS bundle ID (per `docs/FOUNDER_HANDOFF.md` C5, marked "optional"). Founder hasn't done this yet. Not a real bug, but it lets unrelated parties consume the project's Firebase quota with crafted clients. Recommended fix: 5 min in Console.

### P1 — High

**P1-1. AI proxy has no rate limit (`ai-proxy/worker.js:31-82`).**
The Worker verifies the Firebase ID token, then forwards to Anthropic with the project's key. A signed-in user can therefore call the Worker as fast as they can issue requests. Model is allowlisted, max_tokens capped at 2000, but at $0.003/$0.015 per 1k tokens on Sonnet, a malicious authenticated user could burn $100+/hour of Anthropic credit. **Fix:** add a per-uid sliding-window in Workers KV or Durable Objects (~30 LOC). Critical before flipping `AI_ENABLED=true` for paying users.

**P1-2. Email enumeration protection + password policy not enabled (per FOUNDER_HANDOFF C1/C2).**
Firebase Auth v10+ collapses `wrong-password` and `user-not-found` server-side WHEN the Console toggle is on. The toggle is off (`docs/FOUNDER_HANDOFF.md:51-54`). `lib/auth.js:44-55` maps both codes to the same string client-side, which is the right hygiene, but the server still leaks the distinction in the raw response. Password policy minimum length is not enforced server-side — the client check `lib/auth.js:46` rejects `auth/weak-password` errors but a stale Console default allows 6-character passwords.

**Exploit:** scripted login attempts can enumerate which `@demo.verrocchio.app` (and which real-user) emails exist. With the leaked demo password (P0-1), this confirms the four demo accounts are live. **Fix:** founder flips two Console toggles. 30 seconds of work blocked on Console access.

**P1-3. XSS surface is small but `marked` is not wired safely if it ever lands client-side.**
Verified: grep across `index.html`, `lib/*.js`, `utils.js` finds **zero** `innerHTML = …`, `dangerouslySetInnerHTML`, `document.write`, or `eval()` calls in app code. The only `innerHTML`-adjacent surface is the splash-screen toast at `index.html:1248-1251` which sets `div.textContent = "New version available…"` (safe). The codebase is rendered entirely through `React.createElement` with string children, so user-supplied habit names / journal entries can't break out. `marked` is a `devDependencies` entry used ONLY by `scripts/render-docs.mjs` (server-side, builds the public privacy/support pages) — not loaded in the client.

**Caveat:** the privacy/support pages rendered by `scripts/render-docs.mjs:38` call `marked.parse(md)` without an explicit `sanitize` option. Since `marked` v8+ removed the built-in sanitizer, and the input is the project's own markdown files (not user content), the practical XSS risk is zero today. But if anyone ever feeds user input through `marked.parse` without DOMPurify, it becomes immediate. Add a comment + lint rule.

**P1-4. `limitsNavigationsToAppBoundDomains: false` in `capacitor.config.json`.**
Permissive setting. The app DOESN'T set `server.url`, so it loads bundled HTML — but any in-app link to a non-app-bound domain runs in the WKWebView under the same origin as the app, which is the wrong default for a privacy-claiming product. Flip to `true` and add the Firebase + Cloudflare origins to App Bound Domains in `Info.plist` if/when needed.

**P1-5. Forgot-password flow uses Firebase's default email template.**
No code-level review needed; the flow is `auth.sendPasswordResetEmail`. Default template lands in spam disproportionately and uses a Firebase-branded sender by default. Cosmetic, but for a paid product, configure a verified custom sender domain.

**P1-6. Delete-account flow's storage cleanup is best-effort with swallowed errors (`lib/auth.js:175-195`).**
`deleteAccountData` lists `users/<uid>/content` and deletes items with `.catch(() => {})`. If the listAll() succeeds but one delete fails, the orphaned Storage object survives the account deletion. Privacy-policy compliance risk: "we delete your Firebase Storage uploads" in `docs/PRIVACY_POLICY.md` §7 isn't strictly true. Fix: collect failures and either retry or surface to the user; alternatively, run a scheduled Cloud Function that GC's orphaned content.

### P2 — Medium

**P2-1. Privacy policy claims accuracy is OK with minor gap.**
`docs/PRIVACY_POLICY.md` §2 says "we do not run analytics SDKs, ad networks, or third-party trackers." Verified: no Sentry, no Mixpanel, no Segment, no GA. The Cloudflare Worker is server-controlled and only handles AI prompts. The privacy label at `docs/APP_STORE_PRIVACY_LABEL.md` correctly excludes IDFA + tracking. Good. The minor gap: the policy says §13 "the App does not present an ATT prompt because no tracking occurs" — accurate today, but if you ever add ANY third-party analytics this needs the ATT prompt before the SDK fires.

**P2-2. Service worker cache invalidation: solved well.**
The `SHELL_VERSION` discipline + `cleanupOutdatedCaches()` + manual `caches.keys()` sweep handles the legacy-cache problem (`service-worker.js:44-60`). v70 deploys have stabilized this. The `controllerchange` listener at `index.html:1240-1254` reloads ONCE on SW handoff. This is mature.

**P2-3. Firestore data model is one big document.**
Everything (habits, goals, todos, journal, achievements, completions) lives in `users/<uid>` as a single doc. Firestore doc size cap is 1 MB. A power user with 3 years of daily journal entries + 200 habit completion records will hit this. There's no chunking strategy. Symptom will be silent write failures (the user's "fire-and-forget" save() will fail), the `sanitizeForFirestore` strips fileData (`index.html:6433`) but doesn't shard. Recommend migrating completions/journal to subcollections before the first power user complains.

**P2-4. Demo persona accounts persist as real Firebase users forever.**
PRIV-04 in `docs/research/.../01-privacy.md` flagged this. They're real accounts, never expire, share a password. Even if rotated, the `@demo.verrocchio.app` accounts will accumulate as zombie accounts on every reseed. Plan a scheduled cleanup.

---

## 4. Code quality + bugs

### 4.1 The 30,002-line `index.html`

Single `<script>` tag (line 1100 to line 30000). `function App()` at `index.html:3723` is roughly **26,000 lines of a single React component**. Roughly 305 hook calls in one closure. This is by deliberate choice — `.claude/CLAUDE.md` enforces the "single-file PWA invariant" — but it is the dominant technical debt in the codebase.

What's been factored OUT and is healthy:
- `utils.js` (379 LOC): pure date/streak/correlation logic. Well-named, well-commented, dual-loaded (browser + CommonJS for tests). 560-line `tests/utils.test.mjs` covers it.
- `lib/auth.js` (221 LOC), `lib/hydration.js` (275), `lib/icalendar.js` (242), `lib/dialog.js` (128). All small, focused, Node-testable.

What's NOT factored out: the 26,000-line App. Everything else lives in it — UI, data wiring, save logic, AI requests, drag-and-drop, the splash screen, the onboarding tour, every modal. Six months of regression history (`SHELL_VERSION` reached v70) is built on top of it.

### 4.2 Date/time handling

`utils.js:dk` (`utils.js:12-17`) deliberately AVOIDS `toISOString()` and uses local `getFullYear/getMonth/getDate`. Correct — comment at line 9 explains why ("would convert to UTC first, which silently shifts the 'day' by ±1 near midnight"). `recentDays` at `utils.js:141-151` sets `base.setHours(12, 0, 0, 0)` before subtracting days — explicitly to avoid DST edges. Streak math at `utils.js:51-86` walks past `h.startDate` so new habits don't get phantom streaks. Today is given a grace pass.

**The date math in `utils.js` is sophisticated and is the strongest part of the codebase.** It is also where the founder + Claude were clearly most diligent.

### 4.3 Race conditions

`save()` is fire-and-forget Firestore `set()` queued onto Firestore's offline mutation queue, with `lastSaveRef` parking failed payloads (`index.html:7230-7233`). The sign-out flow (`flushPendingWritesAndSignOut` at `lib/auth.js:116-163`) walks pending writes BEFORE signing out — extracted because the old order (`signOut → terminate → clearPersistence`) was eating in-flight writes. Comment at `lib/auth.js:96-115` documents this incident in detail.

Multiple-tabs path uses `synchronizeTabs: true` so the IndexedDB mirror is leader-elected across tabs. Reasonable. The "cross-device slot completion merge" hydration at `index.html:3361` was a fix for a specific data-loss bug. The hydration step is now in `lib/hydration.js` with `tests/hydration.test.mjs` (389 LOC) pinning it.

### 4.4 Error handling — empty catches

**89 empty-or-nearly-empty `catch (_) {}` blocks in index.html.** Sampled:

- `index.html:1108`, `1109`: in the global error reporter itself, intentional (failed `localStorage.setItem` shouldn't crash logging).
- `index.html:1168-1169`: `try { document.body.dataset.device = profile; } catch (e) {}` — intentional, body may not exist.
- `index.html:1213`, `1219`, `1233`, `1252`: SW lifecycle, intentional.
- `index.html:6301`: `try { save({ ...data, tourDone: true }); } catch (e) {}` — **wrong**. If a save fails here, the tour's done-state is lost forever and the user sees the tour again. Should log and retry.

The majority of empty catches are defensible (SW, localStorage, dataset writes that don't matter). A handful are **save-related** and silently lose data on first failure — these violate the project's own "fail closed" rule in `.claude/CLAUDE.md`.

### 4.5 Performance

1.48 MB HTML on initial load. With Firebase Hosting `immutable` cache headers on static assets, repeat loads are fine, but cold start on a 3G phone is 5–8s. The SW precache (`service-worker.js:33-42`) covers the next load. The SPA never code-splits — Chart.js is the one lazy-loaded chunk (`index.html:34, ensureChartJs`).

305 hooks in one `useState` tree means every render re-runs every memo. There's heavy use of `useMemo` but the dep arrays are large. Drag-and-drop had repeated render-storm bugs (per `git log` commits `fcff142`, `345086d`, `341e4b9`) culminating in the SortableJS port. The current SortableJS path is correct (CDN + useEffect lifecycle + manual unmount cleanup).

### 4.6 Accessibility

- 119 `aria-*` attributes in `index.html`. Not zero, not great. For a 30k-line app this is sparse.
- 17 `focus()`/`autoFocus`/`tabIndex` mentions. Most modals do NOT manage focus.
- `lib/dialog.js` wraps `a11y-dialog` for focus-trap + escape + return-focus on 4 dialogs after the Port #6 pilot, but most modals still use hand-rolled `useState` open/close without focus management. The audit at `docs/research/.../03-ux.md` flagged this as UX-blocker territory.
- No skip-to-content link, no landmark roles (`<main>`, `<nav>`), no `aria-live` for the AI-streaming output. The bottom-nav tabs are `<button>`s with `aria-label` (`index.html:tail`), which is OK.

### 4.7 Test coverage

- **Unit tests** via `node --test`: `utils.test.mjs` (560), `hydration.test.mjs` (389), `icalendar.test.mjs` (359), `auth.test.mjs` (400). All cover the extracted `lib/*` and `utils.js` thoroughly with table-driven specs.
- **E2E via Playwright** (`playwright.config.js`, desktop + iOS WebKit): `smoke.spec.js` (7 LOC — title check), `offline.spec.js` (59), `sw-migration.spec.js` (69), `dialog.spec.js` (85), `dialog-real-app.spec.js` (172), `habit-reorder-layered-drop.spec.js` (130).

**What's tested:** date/streak/correlation math, the four extracted lib modules, SW offline contract, SW migration, drag-and-drop layered drops, dialog focus traps.

**What is NOT tested:** all 26,000 lines of `App()`. No tests for habit creation, completion toggling, goal CRUD, todo CRUD, journal CRUD, the daily ritual surface, the multi-slot habit time-stamping, the achievement engine, the entire AI proxy roundtrip from client-side, multi-tab sync, account delete, account email/password change, the forgot-password flow, the demo persona path, the seed migration, OR the 1MB Firestore-doc cap. Test coverage on the bulk of the app is **roughly zero**.

The Playwright config also has a wart: `webServer.command: "powershell -ExecutionPolicy Bypass -File ./serve.ps1"` (`playwright.config.js:24`) — this only runs on Windows. On the founder's macOS dev machine, `npm run test:e2e` will fail to start the server. Either it's been broken since landing or the founder runs tests only on Windows.

### 4.8 Dependency hygiene

`npm audit` reports **0 vulnerabilities** in the small dev-deps tree (Capacitor 8.3.3 → 8.3.4 patch, marked 14 → 18 major). `ai-proxy/` uses `jose@6.2.3` for JWT, current. The browser path doesn't `npm install` anything — React/Firebase/SortableJS/a11y-dialog/ical.js come from CDN with SRI hashes pinned on the Firebase + React entries. ical.js + SortableJS are NOT SRI-pinned because they're version-mutable paths (comment at `index.html:50` justifies this).

### 4.9 Specific bugs found

1. **`index.html:6301`** — `try { save({ ...data, tourDone: true }); } catch (e) {}` silently swallows save failures, causing the onboarding tour to re-run on next session. SEV: medium.
2. **`playwright.config.js:24`** — `powershell -File ./serve.ps1` hard-codes Windows; `npm run test:e2e` is non-portable. SEV: medium for a cross-platform dev team.
3. **`lib/auth.js:182`** — `await Promise.all(listResult.items.map(r => r.delete().catch(() => {})))` swallows per-file delete failures during account deletion, leaving orphaned Storage objects. Violates privacy-policy claim. SEV: medium (privacy + cost).
4. **`ai-proxy/worker.js:64-80`** — no rate limit per user. SEV: high once AI features ship to paid users.
5. **`index.html:6433-6510`** — `sanitizeForFirestore` strips `fileData` from cloud writes but a user who imports an old export from a different device will re-introduce fileData on their localStorage; the migration loop at `index.html:6455` may run on every effect tick if the migration silently failed (the `done++` happens regardless of error, so the `stale` count drops on next render, but on a hard failure the user gets no retry). SEV: low/medium.
6. **`index.html:1115`** — Firebase web API key not restricted by referrer (founder Console action C5). SEV: low (rules enforce real access) but project quota is exposed.
7. **`capacitor.config.json:10`** — `limitsNavigationsToAppBoundDomains: false`. SEV: low/medium.
8. **`firestore` data model** — single doc per user, 1 MB cap, no sharding plan. SEV: medium (latent, will bite power users after ~12-18 months of journal entries).
9. **`scripts/seed-demo-users.mjs:31`** — `const FIREBASE_API_KEY = "AIzaSyDqweiDzza1Jkk-Amppy9ZfMvhc8AHHC_k";` hard-coded again (parallel to `index.html:1115`). Not a security bug (the key isn't secret), but the duplication invites drift. SEV: trivial.
10. **`firebase.json` headers** — no Content-Security-Policy header. With React+UMD+inline scripts this is hard to add cleanly, but for a paid privacy-claiming product, a permissive CSP that at least blocks `frame-ancestors` and known-bad domains is a credibility win. SEV: low.

---

## 5. Documentation + dev maturity

The `docs/` folder is **18 files, 6054 lines**. The standouts:

- `docs/master-plan.md` (1198 LOC) — App-Store v1.0 launch master plan. Operational discipline (§0), wave/task structure, canary validation, anti-spiral rules. This is professional-grade work — better than most engineering orgs produce. Score: 9/10.
- `docs/FOUNDER_HANDOFF.md` (211 LOC) — exactly the right document: every Apple/Firebase/legal step that can't be subagent-automated, with time estimates, dependencies, and credentials needed for optional delegation. Score: 10/10.
- `docs/PRIVACY_POLICY.md` (112 LOC) — accurate, GDPR + CCPA + child-protection sections, AI-feature disclosure. Score: 9/10 (the storage-cleanup gap in §3 P1-6 should be either fixed or hedged in the text).
- `docs/MONETIZATION_V1.md` (439 LOC) — implementation-ready entitlement model, state machine, schemas, rollout. Score: 8/10 (depends on TODO.md cross-refs for caps; not self-contained).
- `docs/SOCIAL_LAYER_V1.md` (412 LOC) — speculative; community is unshipped, but the doc lays out the design. Score: 7/10 (current).
- `docs/TODO.md` (1917 LOC), `docs/USER_REQUESTS.md` (419), `docs/MARKETING_LANDING_BRIEF.md` (368), `docs/ONBOARDING_V1.md` (467) — all serious, all current.
- `docs/research/2026-05-12-appstore-readiness/` — 6 parallel-audit files (privacy, iOS, UX, security, code-quality, PWA-build). This is where every finding I've reproduced was first documented. Score: 9/10.

**Currency: very high.** Most docs were touched within the last 4 days. Many docs cross-reference specific commit IDs and Wave/Task IDs.

Git iteration story: **433 commits over ~5 months** (initial dump commits in Feb 2026, then sustained work). Multiple rewrites (drag-and-drop migrated from hand-rolled pointer events → SortableJS, SW migrated from hand-rolled → Workbox, modal-focus from hand-rolled → a11y-dialog, iCal from hand-rolled → ical.js, JWT from hand-rolled → jose). Each port has a research doc, a TDD pin, and a follow-up commit. The pattern is mature.

**Dev maturity score: 8/10.** This is a non-technical founder running a disciplined Claude Code workflow. The documentation, test coverage on extracted modules, security-rule diligence, and incident postmortems (the sign-out data-loss fix is documented in detail) are all above average for a solo SaaS product.

---

## 6. Bottom line

**Is it safe to ship to App Store today?** Mostly yes — with two caveats. The Firestore + Storage rules are tight, AI proxy is auth-gated, the privacy posture is real (no analytics, no trackers, no ATT prompt needed). The two blockers are (1) demo-password rotation + ideally history rewrite, (2) Firebase Console toggles for email enumeration + password policy. Both are Console-only and take ~10 min. After that, TestFlight + App Store submit is a defensible product.

**Is it safe for paid users?** Not yet — AI proxy has no per-user rate limit (P1-1), the 1 MB Firestore doc will silently break power users in 12-18 months (P2-3), and the orphaned-Storage-on-delete bug undercuts the privacy policy. Fix those three before charging money.

**Is it safe to merge with another product?** The codebase is **salvageable, not pristine**. The 30,002-line `index.html` is a hard structural integration point — anyone porting it into a multi-file React/Next.js project is signing up for a 2-4 week rewrite of `App()`. But the extracted `lib/*` modules, `utils.js`, the Worker, the Firestore rules, and the docs are all portable as-is and are higher-quality than typical solo-founder code.

**Single biggest risk:** the 30,002-line `App()` component. Six months of regression history live there. Any non-trivial change risks landing a UX bug that ships through to the next SHELL_VERSION. This is not a security risk — it's a velocity risk for whoever owns the code next.

**Single most impressive thing:** the `docs/master-plan.md` + `FOUNDER_HANDOFF.md` + research-doc set. A non-technical founder, working with Claude Code, produced an App-Store launch plan with better structural discipline than most early-stage engineering orgs. The doc explicitly names anti-patterns ("forbidden phrases" in dispatched subagent prompts at `master-plan.md:0.2`), enforces canary validation, and separates human-bound from agent-bound tasks. That meta-process is genuinely transferable.

**Verdict: salvageable as-is for v1.0 App Store; major-refactor needed (split `index.html` into modules) before scaling the team past one founder + one agent.** A rebuild in another framework is not warranted — too much working product would be discarded.
