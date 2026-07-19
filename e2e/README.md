# End-to-End Smoke Harness

**Phase 0b** of the Access & Organization Redesign · v2.6

## Why this exists

It gates **Phase 2**. That phase rewrites `resolveProjectAccess` — consulted on effectively
every authenticated request — behind an `off → dual → on` flag. The backend integration
suite covers the resolver in isolation, but nothing proves the *application* still works
after the flag moves. Five flows through a real browser do.

The suite is deliberately small. A large e2e suite nobody trusts is worse than five specs
that always mean something. Every flow here is one whose breakage makes the product
unusable; nothing else belongs.

## Running it

The harness drives an **already-running stack**. It does not build, migrate, or seed —
those are the deploy's job, and a harness that quietly re-migrates can mask a broken
migration.

```bash
# 1. Backend on :4000 and frontend on :5173 (see the repo README)
# 2. Then:
cd e2e
npm install
npm run install-browsers      # one-off
npm test
```

Against staging:

```bash
E2E_BASE_URL=http://staging-host:8080 \
E2E_EMAIL=smoke@example.com \
E2E_PASSWORD='...' \
npm test
```

| Variable | Default | Notes |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:5173` | |
| `E2E_EMAIL` | `admin@taskhub.local` | Seeded admin |
| `E2E_PASSWORD` | `admin` | Seeded admin |

**The smoke account must have two-factor authentication disabled.** The harness cannot
complete a TOTP challenge and fails with that message rather than a bare timeout.

## How authentication works

The SPA keeps the access token in axios module memory only — never localStorage, never
context — to limit XSS blast radius. So `storageState` captures no access token.

What it *does* capture is `th_refresh`, an httpOnly cookie scoped to `/api/auth`. A
restored context therefore starts with a valid refresh cookie and no access token, and the
axios refresh-on-401 interceptor mints a fresh one on the first API call. That is the real
production flow, so reusing state exercises refresh rather than bypassing it.

`.auth/user.json` holds a live refresh cookie and is gitignored. Treat it as a credential.

## Three things that would otherwise make this flaky

These are handled in `tests/fixtures.ts`, and each was a real trap found while writing it:

1. **`window.confirm` on every destructive action.** Without a dialog handler, Playwright
   leaves the dialog open, the click never resolves, and the test hangs to timeout instead
   of failing usefully.
2. **Persisted view modes.** `projects.viewMode` (`all` | `buckets`) and `kanban.viewMode`
   (`status` | `list` | `responsible`) are remembered in localStorage, and each mode
   renders a completely different DOM. A previous run can leave the app in a mode where
   the selectors match nothing. Both are pinned before every test, and
   `projects.selectedTeam` is cleared so a remembered team filter can't hide the fixture.
3. **`ProtectedRoute` renders `null` during auth refresh.** Waiting on "page has content"
   races it. Wait on a URL or a concrete element.

## Selectors

The frontend had **one** `data-testid` in the entire codebase before this phase, so most
elements had no stable hook — labels are i18n'd (EN + FA) and classNames are Tailwind
utilities shared across components.

Phase 0b added the minimum set needed, each marked with a `v2.6, Phase 0b` comment:

| testid | File |
|---|---|
| `project-row` + `data-project-id` | `features/projects/ProjectListRow.tsx` |
| `project-open` | `features/projects/ProjectListRow.tsx` |
| `projects-new`, `projects-list` | `pages/ProjectsPage.tsx` |
| `task-create-title`, `task-create-submit` | `pages/TasksPage.tsx` |
| `task-row` + `data-task-id` | `pages/TasksPage.tsx` |

Elsewhere the suite uses selectors that are stable because they are hardcoded English a11y
attributes rather than translated strings: `button[aria-label="Close"]`,
`select[aria-label="Status"]`, `button[aria-label="Delete task"]`, `[role="dialog"]`,
`.dialog-panel`, `[role="menu"]`, `input[autocomplete="username"]`. Enum `<option>` values
(`TODO`/`IN_PROGRESS`/…, `READONLY`/`FULL`) are a genuine contract and safe to assert on.

Those a11y attributes are stable **by accident** — nobody has i18n'd them yet. When adding
coverage, add a testid rather than depending on one more of them.

## Known gaps

- **Chromium only.** Cross-browser rendering is not what this gates.
- **The sharing panel assertion is conditional.** `ProjectTeamSharesPanel` renders only for
  a global ADMIN. The spec asserts the modal opens for any account and checks the panel
  only when present — a suite that demanded ADMIN would fail for a legitimate reason and
  report it as a broken sharing panel.
- **No visual regression, no accessibility assertions.** Out of scope for a gate.
