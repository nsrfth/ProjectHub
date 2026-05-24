# TaskHub — User Manual

Version **v1.20.0** (2026-05-24)

This manual covers everything a member, manager, or admin needs to do day-to-day. For operator / deployment topics (env vars, backups, scaling), see `README.md`, `BACKUP.md`, and `ARCHITECTURE.md`.

---

## Table of contents

1. [Concepts](#concepts)
2. [Signing in](#signing-in)
3. [The corner buttons (About / Help / Notifications)](#the-corner-buttons-about--help--notifications)
4. [Teams and projects](#teams-and-projects)
   - [Team colours](#team-colours)
5. [Tasks — the basics](#tasks--the-basics)
6. [The three dates: Due by, Planned on, Completed on](#the-three-dates-due-by-planned-on-completed-on)
7. [Labels, subtasks, attachments, comments](#labels-subtasks-attachments-comments)
8. [Recurring tasks](#recurring-tasks)
9. [Calendar views](#calendar-views)
10. [Reports](#reports)
11. [Notifications](#notifications)
12. [Two-factor authentication (2FA)](#two-factor-authentication-2fa)
13. [Display preferences (calendar / theme / language)](#display-preferences-calendar--theme--language)
14. [Personal API tokens](#personal-api-tokens)
15. [Admin / manager — Settings](#admin--manager--settings)
    - [Workweek (off-days)](#workweek-off-days)
    - [Directories (LDAP)](#directories-ldap)
    - [SCIM provisioning](#scim-provisioning)
    - [Webhooks](#webhooks)
    - [Audit log](#audit-log)
16. [Troubleshooting](#troubleshooting)

---

## Concepts

TaskHub organises work in three layers:

- **Team** — the top-level tenant. Everything you see is scoped to a team. Members in different teams don't see each other's data.
- **Project** — belongs to a team. A project is just a named container of tasks (often a product, a workstream, or a "bucket").
- **Task** — the unit of work. Has a title, description, status, priority, assignee, three optional dates, labels, subtasks, attachments, comments.

Two roles matter:

- **Global** role — `ADMIN` or `MEMBER`. Set on the user account. `ADMIN` has instance-wide privileges (manage Directories, see all audit, etc.).
- **Team** role — `MANAGER` or `MEMBER`. Set per-team. `MANAGER` can invite + remove members, configure webhooks, and see the team's audit log.

You can be a global `MEMBER` and a team `MANAGER` at the same time — these are independent.

---

## Signing in

1. Open the URL your admin gave you (usually `https://taskhub.<your-org>/`).
2. Enter email + password.
3. If 2FA is enabled on your account, you'll see a second step asking for a 6-digit code from your authenticator app — enter it. (You can substitute a single-use recovery code in the same field.)
4. After signing in, the **Dashboard** shows your name, your global role, your teams, and quick links to **Admin** (admins only) and **Settings** (everyone).

If your account is owned by an LDAP directory, you log in with your LDAP password — the form is identical.

---

## Top navigation (v1.15)

Once you're signed in, a sticky **navigation bar** sits at the top of every page:

- **TaskHub** (brand link, far left) — jumps to the Dashboard.
- **Dashboard / Projects / Calendar / Reports / Teams** — your primary destinations. The active page is highlighted in dark.
- **Admin** — visible only for global `ADMIN` accounts.
- **Settings** (right side) — opens whichever Settings sub-page you last visited (defaults to **Preferences**).
- **Sign out** (far right) — ends the session.

The corner buttons (ℹ️ About / 📖 Help / 🔔 Notifications) stay in the top-right; the nav bar leaves room for them.

---

## The corner buttons (About / Help / Notifications)

Three small pill buttons live in the top-right corner of every authenticated page:

- **ℹ️ About** — opens `/about` with the running instance's version, build time, environment, off-day set, headline counts, license, and links to the manual + changelog. **v1.16:** if your operator opted in (`UPDATE_CHECK_ENABLED=true`) and you're an admin, an "↑ Update available: vX.Y.Z" pill appears next to the version when GitHub has a newer release. Clicking it opens the release notes on GitHub.
- **📖 Help** — opens `/help`, an in-app render of this manual. The same content GitHub readers see, formatted with proper headings, tables, code blocks. Has an "Open raw markdown" link in the corner for ops scripts.
- **🔔 Notifications** — the existing notification bell; opens a dropdown of recent items + an unread badge.

The buttons appear on every signed-in route so you can always reach help / context without hunting.

---

## Teams and projects

- **Teams** page — click the team-name dropdown on the dashboard or go to `/teams`. Lists every team you belong to and lets you switch the "current team" (drives what the kanban / reports / settings show).
- **Create a team** — click **New team**, give it a name + slug (URL-safe, dash-delimited, e.g. `growth-eng`).
- **Invite a member** — open the team detail, type their email, pick role `MEMBER` or `MANAGER`. (Only `MANAGER`s can invite.)
- **Projects** page — once you're inside a team, click **Projects** to see the team's projects. New project: name + optional description + **Accountable** (v1.17 — the team member on the hook for this project's outcomes, in RACI terms; optional). Owners + managers can change Accountable inline on the project list.

> Directory-managed teams (set up via LDAP/SCIM by an admin) have their membership synced from the IdP — manual invites are disabled there.

### Team colours

Each team can carry an accent colour that shows up on kanban cards (as a left stripe) and on the Calendar views (as the task-pill background).

**To set** — Teams page → pick the team → click any of the 8 preset swatches, or use the native colour picker for a custom hex. **Clear** removes the colour and falls back to slate. Only team `MANAGER`s (or global `ADMIN`s) see the picker.

Colours are purely visual — they don't change permissions or filtering.

---

## Tasks — the basics

The **Kanban board** (`/projects/<id>/tasks`) is the main work view:

- Four columns: **To do**, **In progress**, **Review**, **Done**.
- Drag a card between columns to change its status.
- Drag within a column to reorder.
- Click a card to open the **Task detail** page.

To create a task: click **New task** on the board, fill in at least a title, optionally pick a priority / assignee / description, hit save. New tasks land at the top of **To do**.

Each card on the board shows:

- title
- priority dot
- assignee initials
- the three dates (if set) in three different colours

---

## The three dates: Due by, Planned on, Completed on

Tasks have three independent date fields. The split matters:

| Field | Meaning | What uses it |
|-------|---------|--------------|
| **Due by** | Hard deadline. "This must be done by …" | Triggers `TASK_DUE` reminders 24 h before. Drives the Overdue report. |
| **Planned on** | Team's target completion date. "We plan to finish by …" | Drives the **Timeliness** report (on-time rate, avg variance). Does NOT trigger reminders. |
| **Completed on** | Actual finish date. Auto-fills on first transition to **Done**. | Drives the **Tasks completed** report. Can be backdated manually. |

All three are calendar dates (not timestamps). They render in whichever calendar you've chosen — Shamsi or Gregorian — but the underlying storage is UTC midnight, so two users in different timezones / calendars see the same DAY.

**To set them**: open the task detail page → scroll to the **Dates** section → click any of the three pickers → choose a date → click **Save** under that picker. Each date is saved independently.

To clear a date, click **Clear** under it.

---

## Labels, subtasks, attachments, comments

On the task detail page:

- **Labels** — coloured tags scoped to the team. Click **Add label**, pick from the dropdown (or create a new one with name + colour). Click an attached label's × to remove it.
- **Subtasks** — ordered checklist. Add a title, hit Enter. Toggle the checkbox to mark done. Drag the handle to reorder. A subtask's `done` state doesn't auto-affect the parent task's status — toggling subtasks is just a per-step record.
- **Attachments** — drag-drop or click to upload files (≤ the upload limit your admin configured, default 10 MiB). Files download via authenticated links.
- **Comments** — free-text. Press Enter to post (Shift+Enter for newline). Use `@email-localpart` to mention a team member (e.g. `@alice` for `alice@example.com`) — they'll get a `MENTION` notification.

Comments and labels generate audit-log entries; subtask + attachment changes don't (deliberate to keep the activity feed readable).

---

## Recurring tasks

A task can carry a **recurrence rule** that spawns a fresh copy on a schedule.

**To set up**:

1. Open the task you want to repeat.
2. Scroll past **Attachments** to the **Recurrence** section.
3. Click **Set up recurrence**.
4. Fill the form:
   - **Frequency**: Daily / Weekly / Monthly / Quarterly / Yearly
   - **Every N**: interval (1 = every one, 2 = every other)
   - **On weekdays**: only visible for Weekly — tick Mon / Wed / Fri etc.
   - **Starts on**: first eligible spawn date
   - **Ends on** (optional): hard cutoff
   - **Max occurrences** (optional): cap on total spawns
   - **Due offset (days)**: spawned task's `dueDate` = spawn date + N days. Leave empty to skip.
   - **Planned offset (days)**: same for `plannedDate`.
   - **Active**: uncheck to pause without deleting.
5. **Save recurrence**.

The summary then reads something like:

> Every 2 weeks on Mon, Wed · Next run: 27 May 2026 · spawned 3 of 10 so far.

When the scheduler ticks past the next-run date, a brand-new task appears in **To do** with the title / description / labels / subtasks copied from the source. Completed-on is never copied. The link back to the source is preserved (you'll see it in the audit log).

**Important**: the scheduler is **off by default**. Your operator needs `RECURRENCE_ENABLED=true` in the deployment's `.env`. Without that the rule is saved but nothing spawns until they enable it (or until a manager hits the manual "tick" endpoint from a script).

---

## Calendar views

The `/calendar` route (linked from the Dashboard) shows tasks from every project in the current team laid out on a date grid. Three view modes:

- **Work-week** — 5 cells starting on the first non-off-day. With Sat+Sun off, the first column is Monday; with Thu+Fri off, it's Saturday. The off-day setting drives both *which* 5 days appear and *where* the cursor lands.
- **Week** — 7 cells, Sunday-leading. Off-days are still tinted red.
- **Month** — full 6-week grid (42 cells). Days outside the current month are dimmed. Each cell shows up to 3 tasks + "+N more".

Each task appears as a coloured pill — the pill colour is the **team accent** ([Team colours](#team-colours) above). Click the pill to jump to the task.

The **Date field** dropdown on the toolbar lets you bucket by `dueDate` (default — "what's due when") or `plannedDate` ("what we're targeting"). Completed tasks aren't shown — they belong in Reports, not the forward-looking calendar.

Off-days are determined by the [Workweek](#workweek-off-days) admin setting (see below). They render with a red label + a red-50 background tint so they're impossible to miss.

---

## Reports

Click **Reports** in the dashboard header. All sections are team-scoped (current team in the dropdown).

- **Summary** — four counters at the top: Open / In progress / Done (7d) / Overdue.
- **Tasks completed** — list of tasks completed in the trailing window (7 / 30 / 90 days), plus per-assignee tally.
- **Timeliness** — over the same window:
  - **On-time rate** — of tasks that had both `plannedDate` and `completedAt`, what fraction landed on or before plan. Colour-coded ≥80% green, ≥50% amber, lower red.
  - **Avg variance** — mean (`completedAt − plannedDate`) in days. Positive = late on average, negative = early.
  - **Behind plan** — count of *open* tasks whose `plannedDate` is in the past. Unaffected by the window.
- **Workload** — open tasks per assignee, broken down by status. Catches the "Bob has 22 open in-progress tasks" pattern.
- **Overdue** — open tasks past their `dueDate`, oldest first.

All timestamps in reports render in your chosen calendar.

### Exporting to CSV (v1.14)

Each report section (Tasks completed / Timeliness / Workload / Overdue) has an **Export CSV** button. Clicking it downloads a UTF-8 CSV with the section's data, named e.g. `tasks-done-7d-2026-05-24.csv`. The file opens cleanly in Excel, Numbers, and Google Sheets. The Summary widget is not exported on its own — its three numbers already live inside Workload / Tasks completed / Overdue.

---

## Notifications

The bell icon (top-right after sign-in) lights up when you have unread notifications. Types:

| Type | When it fires |
|------|---------------|
| `TASK_ASSIGNED` | You were assigned a task. |
| `TASK_DUE` | A task with you as assignee is due within the lead window (default 24 h). Also fires for already-overdue tasks within a 30-day floor. |
| `TASK_COMMENT` | Someone commented on a task you're involved in. |
| `MENTION` | Someone used `@your-handle` in a comment. |
| `TASK_STATUS` | A task you watch changed status. |

The bell stays in sync over a WebSocket — new notifications appear without refreshing.

Click a notification to jump to the task; that marks it read.

### Email delivery (v1.14)

If the operator configured SMTP, TaskHub also sends emails for:

- **Verification** — when you register, you get a link that confirms your email (valid 24 h).
- **Password reset** — when you request a reset, you get a link to choose a new password (valid 1 h).
- **TASK_DUE** — when the scheduler fires the in-app bell, it also emails the task's assignee and creator.

If your instance has SMTP disabled, you'll see the verification / reset tokens returned in the API response (dev mode only) — operators usually enable SMTP for production. Either way, the in-app bell still works.

---

## Two-factor authentication (2FA)

2FA adds a 6-digit time-based code (TOTP) on top of your password. Compatible with Google Authenticator, 1Password, Bitwarden, Authy, etc.

**To enable**:

1. Go to **Settings → Security**.
2. Click **Enable 2FA**.
3. Scan the QR with your authenticator app — or paste the manual key into it.
4. Type the 6-digit code your app shows.
5. **Confirm + finish**.
6. **Copy the 10 recovery codes** and save them somewhere safe (password manager, printed in a drawer). They're shown only once. Each can be used once if you lose your phone.

**On subsequent logins**: after password (or LDAP) succeeds, the form asks for a 6-digit code. Enter the code from your authenticator app. (Or paste a recovery code — it's burned on first use.)

**To regenerate recovery codes**: Settings → Security → **Regenerate recovery codes**. Invalidates the previous set.

**To disable**: Settings → Security → enter a current TOTP or recovery code as proof → **Disable 2FA**. The proof requirement prevents a stolen access token from disarming your second factor.

LDAP-managed accounts can enable TOTP too — both factors are required at login.

---

## Display preferences (calendar / theme / language)

Three per-user toggles, all on **Settings → Preferences**. Each is independent and travels with you across browsers + devices (stored on the server, mirrored into localStorage at every login). Saving any of them reloads the page so every component picks up the new value cleanly.

### Calendar

- **Shamsi / Jalali** — Persian calendar, Persian digits, RTL date layout (e.g. `۱ خرداد ۱۴۰۵`). Default for new accounts on v1.10+ installs.
- **Gregorian** — Western calendar, English digits, ISO format (e.g. `2026-05-22`).

Affects every date + timestamp the UI renders — kanban cards, reports, audit log, comments, activity — and the date picker itself. Storage is identical: picking "1 Khordad 1405" or "May 22, 2026" produces the same underlying ISO string. Two users with different preferences viewing the same task see the same DAY, formatted their way.

### Theme

- **Light** — the original look. Default.
- **Dark** — slate-900 surface, slate-100 text. Powered by Tailwind's `dark:` variant class on `<html>`. Pre-React bootstrap in `index.html` applies the cached theme before first paint, so no light-flash on dark accounts.

### Language

- **English** — the canonical source language. Default.
- **فارسی (Persian)** — full RTL UI. `<html dir="rtl" lang="fa">` flips automatically; the i18n catalogue covers the highest-traffic surfaces (Dashboard, Login, Settings sidebar, Preferences page, About / Help corner buttons). Strings without a Persian entry fall back to English, so adding a new EN string never breaks the FA UI.

> **Note**: Persian translation is a living catalogue. If you spot an untranslated string (it'll appear in English while the rest is Persian), it's not a bug — it just hasn't been added to `frontend/src/i18n/fa.json` yet.

---

## Personal API tokens

For scripting, CI, or terminal-based work, generate a Bearer token that authenticates as you without going through the JWT login.

**To create**:

1. Go to **Settings → API & Webhooks**.
2. Under **API tokens**: give the token a name (e.g. `CI bot`) + scopes (`*` for full, or specific like `tasks:read,tasks:write`).
3. **Generate**.
4. **Copy the token** from the modal — it's shown only once. Format: `th_<48 hex chars>`.

Use it just like a normal Bearer token:

```sh
curl https://taskhub.example.com/api/auth/me \
  -H "Authorization: Bearer th_a1b2c3..."
```

The token authenticates as you — it sees what you see. Scopes are advisory in v1.10 (no route-level enforcement yet); revoking a leaked token is your fastest mitigation.

**To revoke**: same page → click **Revoke** next to the token. The next request using it returns 401.

---

## Admin / manager — Settings

The **Settings** link in the dashboard header opens the Settings shell. The sidebar items you see depend on your role:

- **Preferences** — everyone (personal calendar + theme + language). Admins additionally see the Workweek section.
- **Security** — everyone (your 2FA).
- **Directories** — global ADMIN only (LDAP / SCIM config).
- **Audit** — global ADMIN or team MANAGER.
- **API & Webhooks** — everyone (tokens) + MANAGER (webhooks for that team).

### Workweek (off-days)

Admin-only section on **Settings → Preferences**. Sets the instance-wide off-day set. Two one-click presets cover the common conventions:

- **Saturday + Sunday off (Western)**.
- **Thursday + Friday off (Iranian / Gulf)**.

An **Or pick custom days** disclosure lets you select any subset of the 7 weekdays (e.g. Friday-only, or a 3-day weekend). Saving reloads the page; every date picker in the app immediately paints the configured days in **red**, and the Calendar views tint those cells with a red-50 background.

The setting lives in the `InstanceSetting` key/JSON store (`calendar.weekend`), read publicly via `/api/system/info` so the date picker has the right colours before login.

### Directories (LDAP)

Bind TaskHub to one or more LDAP servers so users log in with their LDAP credentials.

**To add an LDAP directory**:

1. **Settings → Directories → New directory**.
2. Fill the form:
   - **Name** + **slug** (URL-safe id).
   - **Host** + **port** (default `389` plain or `636` TLS).
   - **Use TLS** checkbox.
   - **Bind DN** + **bind password** — a read-capable service account.
   - **Base DN** — where users live (e.g. `ou=People,dc=example,dc=org`).
   - **Email attr** / **Name attr** / **User-ID attr** / **Group-member attr** — usually `mail`, `cn`, `uid`, `member` for OpenLDAP; `mail`, `cn`, `sAMAccountName`, `member` for AD.
   - **Allow JIT provisioning** — if checked, the first successful login auto-creates the local user row. If unchecked, only pre-created users can log in.
   - **Sync roles from groups** — apply group → role mappings on every login.
3. **Create**.
4. Click **Test** on the row to verify the bind works.

**Group → role mappings**: after creating the directory, you can map LDAP groups to TaskHub roles (global ADMIN/MEMBER, or team MEMBER/MANAGER). On every successful LDAP login, group membership determines roles. Dropping out of a mapped group revokes the corresponding access on the next login.

**Important**: the bind password is encrypted at rest with the server's `MASTER_KEY`. Back up the key alongside the database — losing it makes every LDAP directory unusable.

### SCIM provisioning

Each Directory row can also expose a SCIM 2.0 endpoint so an IdP (Okta, Azure AD, JumpCloud) pushes user state into TaskHub.

**To enable SCIM**:

1. **Settings → Directories** → expand the directory row.
2. Under **SCIM 2.0**, click **Generate token**.
3. **Copy the token** (shown once).
4. Configure your IdP:
   - **Base URL**: `https://taskhub.example.com/api/scim/v2`
   - **Bearer token**: the value you just copied.

The IdP can now push Users + Groups. SCIM PATCH `active: false` deprovisions the user — they're soft-disabled, all refresh tokens are revoked, and they can no longer log in. PATCH `active: true` re-enables.

**To rotate**: click **Rotate** to issue a new token and invalidate the old.
**To revoke**: click **Revoke**. The next SCIM call returns 401.

### Webhooks

Outbound HTTP delivery to your own URLs when team events happen.

**To set up** (team MANAGER):

1. **Settings → API & Webhooks** → ensure the right team is selected.
2. **New webhook**.
3. Fill: name, URL, the events to subscribe to (`task.created`, `task.updated`, `task.status_changed`, `task.deleted`, `comment.added`, or `*` for all).
4. **Create**.
5. **Copy the signing secret** (shown once). Your receiver uses it to verify the `X-TaskHub-Signature` header (HMAC-SHA256 of the body).

**Per-webhook actions**:

- **Test** — fires a synchronous `webhook.test` event and reports HTTP status.
- **Pause / Resume** — toggle `active`.
- **Delete** — remove the webhook.
- **Show recent deliveries** — expandable log: status, attempt count, HTTP code, error message, timestamp.

**Retry behaviour**: failed deliveries (5xx or network error) retry with exponential backoff (30 s, 60 s, 120 s, …) up to 5 attempts. After that the row is marked `FAILED` and ignored.

**Important**: the dispatcher is off by default. Your operator needs `WEBHOOK_DISPATCH_ENABLED=true` in `.env`. Without it, deliveries queue up indefinitely in the `PENDING` status.

### Audit log

**Settings → Audit**. Filter by action substring, actor id, date range, team (admin only). Pagination via **Load more**.

- **ADMIN** sees every team's activity.
- **MANAGER** sees only the activity in teams they manage.
- **MEMBER** doesn't see the link at all (and the API returns 403 if they probe it directly).

Today's vocabulary covers task + comment events. As LDAP / SCIM / 2FA / webhook event emitters land in later versions, they'll appear in the same table.

---

## Troubleshooting

**"I can't see Settings"** — the **Settings** link is shown to every signed-in user. If it's missing, refresh once (the bundle may be cached). If your global role just changed, sign out and back in.

**"My calendar choice doesn't stick"** — make sure the page reloaded after Save. If a cookie / localStorage block is in place (private mode, strict tracking-prevention), the choice falls back to Shamsi on the next visit.

**"My recurring task isn't spawning"** — the scheduler is opt-in. Ask your operator to set `RECURRENCE_ENABLED=true` in `.env` and `docker compose up -d backend`. Or hit `POST /api/teams/<teamId>/projects/<projectId>/tasks/<taskId>/recurrence/tick` manually to verify the rule itself is correct.

**"My webhook fires but the receiver rejects the signature"** — confirm the receiver computes `sha256` HMAC over the **raw body bytes** (not the parsed JSON), keyed with the secret shown at creation, and compares the hex digest against the part of `X-TaskHub-Signature` after `sha256=`.

**"LDAP login says 'Invalid credentials' but the password works elsewhere"** — most common cause is the local user row pre-existing with `directoryId=null`. Ask an admin to delete the conflicting local user; the next LDAP login will JIT-provision a fresh row. The reverse — "we set up LDAP but the existing admin can't log in" — means the admin's row has a `directoryId` they didn't expect. Check the `User` table.

**"I lost my 2FA device and my recovery codes"** — ask a global ADMIN to log into the database and clear `totpEnabled` + `totpSecretEnc` for your row. There's no self-service "I lost everything" flow by design — that would defeat 2FA.

**"The bell isn't updating in real time"** — the WebSocket connects on page load. If you've left the tab open across a server restart, the connection drops; refreshing reconnects.

---

*Need something not covered here? Check `CHANGELOG.md` for the per-version surface, `ARCHITECTURE.md` for the design rationale, or open an issue.*
