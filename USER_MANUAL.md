# TaskHub — User Manual

Version **v1.71.0** (2026-06-09)

This manual covers everything a member, manager, or admin needs to do day-to-day. For operator / deployment topics (env vars, backups, scaling), see `README.md`, `BACKUP.md`, and `ARCHITECTURE.md`.

---

## Table of contents

1. [Concepts](#concepts)
2. [Signing in](#signing-in)
3. [Dashboard](#dashboard-v146)
4. [The corner buttons (About / Help / Notifications)](#the-corner-buttons-about--help--notifications)
5. [Teams and projects](#teams-and-projects)
   - [Team colours](#team-colours)
6. [Tasks — the basics](#tasks--the-basics)
7. [The three dates: Due by, Planned on, Completed on](#the-three-dates-due-by-planned-on-completed-on)
8. [Labels, subtasks, attachments, comments](#labels-subtasks-attachments-comments)
9. [Recurring tasks](#recurring-tasks)
10. [Planner](#planner-v144)
11. [Calendar views](#calendar-views)
12. [Reports](#reports)
13. [Notifications](#notifications)
14. [Two-factor authentication (2FA)](#two-factor-authentication-2fa)
15. [Display preferences (calendar / theme / language)](#display-preferences-calendar--theme--language)
16. [Personal API tokens](#personal-api-tokens)
17. [Admin / manager — Settings](#admin--manager--settings)
    - [Workweek (off-days)](#workweek-off-days)
    - [Security — password policy](#security--password-policy-v143-admin)
    - [TaskHub server](#taskhub-server-v143-admin)
    - [Directories (LDAP)](#directories-ldap)
    - [SCIM provisioning](#scim-provisioning)
    - [Webhooks](#webhooks)
    - [Audit log](#audit-log)
18. [Installing TaskHub as an app (PWA)](#installing-taskhub-as-an-app-pwa)
19. [Troubleshooting](#troubleshooting)

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
4. After signing in, the **Dashboard** aggregates KPIs, charts, workload, upcoming deadlines, and recent activity across **every team you belong to** — not just one team.

If your account is owned by an LDAP directory, you log in with your LDAP password — the form is identical.

---

## Dashboard (v1.46)

The **Dashboard** (`/dashboard`) is your cross-team home screen:

- **KPI cards** — open tasks, overdue, in progress, and completed (last 7 days), summed across all your teams.
- **Completion trend** — bar chart scoped by the period tabs (week / month / quarter).
- **Task status** — pie-style breakdown of TODO / In progress / Review / Done.
- **Team workload** — open tasks per assignee (assignees merged across teams).
- **Upcoming deadlines** — your nearest due tasks across teams.
- **Recent activity** — latest events from all teams you belong to.

The subtitle under the greeting shows how many teams are included (e.g. “Across 4 teams · all projects you can access”). Join at least one team to see data; otherwise a prompt links to **Teams**.

> **Reports** (`/reports`) remain **team-scoped** — pick a team in the Reports header to drill into CSV exports and timeliness detail.

---

## Left sidebar & top bar

The **left sidebar** (always visible on desktop) links to **Dashboard**, **Teams**, **Projects**, **Planner**, **Reports**, **Dashboards**, and **Settings**. Your avatar and name appear at the bottom (links to **Settings → Preferences**).

The **top bar** adds global search and notifications.

---

## Top navigation (v1.15)

Once you're signed in, a sticky **navigation bar** sits at the top of every page:

- **TaskHub** (brand link, far left) — jumps to the Dashboard.
- **Dashboard / Projects / Planner / Reports / Teams** — your primary destinations in the left sidebar. The active page is highlighted.
- **Settings** — left sidebar (opens the first settings section you can access — alphabetically by English label, e.g. **Admin** for global admins). **Admin** and **Trash** live inside Settings for users with access.
- **Sign out** — user menu in the top bar.

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
- **Invite a member** — open the team detail, search by **name or email** (type at least 2 characters), pick a user from the results, and choose role `MEMBER` or `MANAGER`. Users already on the team appear greyed out. Only `MANAGER`s (with `team.invite_member`) can add members. The user must already have a TaskHub account.
- **Remove a member** — managers with `team.remove_member` can remove members from the roster. The last MANAGER cannot be removed. **v1.56:** if the member **owns projects** in the team, removal is blocked until you **reassign ownership** to another team member or choose **Remove anyway** (project `ownerId` stays on the removed user — they are no longer a team member but remain the recorded owner). Owned and accountable projects are listed before you confirm.
- **Member roster (v1.54+)** — each team member shows a **Disabled** or **Locked** badge when their account is in that state. Users with **accepted group access** who are not team members appear in the roster with an **External** badge and **Full access** / **Read only** label — they cannot be removed from the team roster (manage them in User groups).
- **Member roster search & pagination (v1.55)** — on team detail, search by name or email, filter by role / account status / member vs external, click column headers to sort, and page through large rosters (25 per page by default). Changing a filter resets to page 1.
- **Rename a team** (v1.48) — team detail → **⋮** → **Rename team**, edit the name, **Save**. Requires the `team.edit_details` permission (system Manager role by default). Members cannot rename.
- **Delete a team** (v1.48) — **⋮** → **Delete team** → confirm. Allowed only when the team has **no projects** and **no live tasks**; otherwise the dialog lists blockers. Global admins can still force-delete teams (with all content) from **Settings → Admin**.
- **User groups** (v1.50 / v1.51) — on team detail, the **User groups** section appears when you have the `group.manage` permission (system Manager role by default). Create a group, add team members (or search **any user** for cross-team invites), set each member to **Full access** or **Read only**, and grant projects. In-team members join immediately; external users receive an invitation they must **Accept** (see the notifications bell). Read-only members can view tasks and comments but cannot create or edit them. Removing a member or deleting the group revokes access on the next request.
- **Projects** page (`/projects`) — cross-team list of every project you can see (projects you **own**, plus any granted via a user group; managers with `project.edit` also see all team projects). **New project** when you belong to at least one team. Optional **start** and **end** dates (calendar dates, stored UTC-midnight — same day for every viewer). Create and **Edit project** expose the same fields: name, description, status, dates, accountable (RACI), budget (currency, planned), and **labels** (team-wide coloured tags — same catalog as tasks). Assigned labels show as chips on each project row.
  - **⋯ Actions menu** (v1.60.1) on each row you may manage (owner, admin, or team manager): **Edit project** (full field set), **Edit budget** (opens the same edit dialog), **Delete** (with confirm). Managers with rename-only rights can change the name on someone else's project; other fields are disabled in the UI and rejected by the API (403).
- **Personal buckets** (v1.45) — on the Projects page, switch to **Personal buckets** to organize projects into your own columns (e.g. *My Priorities*, *This Quarter*). Buckets are private to you and never change project permissions or data.
  - **+ New bucket** — name, optional description, color.
  - Drag projects into buckets; drag to reorder within a bucket or reorder bucket columns.
  - A project can sit in **multiple** buckets. Use the **☰** menu on a row/card to toggle bucket membership.
  - **All projects** view adds search (project + bucket names) and filters: status, team, owner (admin), created date range.
  - Deleting a bucket removes the grouping only — projects stay intact.

> Directory-managed teams (set up via LDAP/SCIM by an admin) have their membership synced from the IdP — manual invites are disabled there.

### Team colours

Each team can carry an accent colour that shows up on kanban cards (as a left stripe) and on the Calendar views (as the task-pill background).

**To set** — Teams page → pick the team → click any of the 8 preset swatches, or use the native colour picker for a custom hex. **Clear** removes the colour and falls back to slate. Only team `MANAGER`s (or global `ADMIN`s) see the picker.

Colours are purely visual — they don't change permissions or filtering.

### Budget currency (v1.59)

Each team can set a **default currency** (`IRR`, `EUR`, or `USD`) on the team detail page (requires `team.edit_details`). New projects inherit this default; you can pick a different currency when creating or editing a project.

- **Currency of record = the project.** Task budgets always display in the parent project's currency — tasks do not have their own currency picker.
- Amounts are **not converted** when you change a currency — only the display label changes. The UI warns you before saving a currency change.
- **IRR** shows whole numbers (no decimal places); **EUR** and **USD** show two decimal places. English and Persian UI locales format digits and grouping accordingly.

### Automations (v1.60)

Settings → **Automations** lets managers with `automation.manage` define no-code rules for a team.

- **Trigger** — one of: task created, status changed, updated, assigned, or custom field changed.
- **Conditions** — match ALL or ANY of: status, priority, assignee, label, due date, or custom field (typed per field kind).
- **Actions** — set status/priority/assignee, add/remove label, set custom field, add comment (supports `{{task.title}}` tokens), or send notification.
- Rules run **after your save completes** — a failing rule never rolls back your edit.
- **Loop protection** — each rule fires at most once per task per originating change chain; nested depth is capped at 5.

---

## Tasks — the basics

The **Kanban board** (`/projects/<id>/tasks`) is the main work view for a single project:

- Default columns: **To do**, **In progress**, **Review**, **Done** (status grouping).
- **Group by** (v1.44): switch columns to **Assignee**, **Progress** (0%–100% ranges), **Due date** (Overdue / Today / This week / …), or **Label**. Your choice is remembered across visits.
- Drag a card between columns to change status — **only when grouped by Status**.
- Drag within a column to reorder (status grouping only).
- Toggle **List** or **by Technician** for alternate layouts on the same data.
- In **List** view, tasks with subtasks show a chevron and subtask count (collapsed by default); expand to see indented subtask rows.
- Click a card to open the **Task detail** page.

To create a task: use the inline form at the top of the board, fill in at least a title, optionally pick a priority, hit **Add task**. New tasks land at the top of **To do**.

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
| **Due by** | Hard deadline. "This must be done by …" | Triggers `TASK_DUE` reminders (default **24 h** before; configurable per user on **Settings → Preferences**). Drives the Overdue report. |
| **Planned on** | Team's target completion date. "We plan to finish by …" | Drives the **Timeliness** report (on-time rate, avg variance). Does NOT trigger reminders. |
| **Completed on** | Actual finish date. Auto-fills on first transition to **Done**. | Drives the **Tasks completed** report. Can be backdated manually. |

All three are calendar dates (not timestamps). They render in whichever calendar you've chosen — Shamsi or Gregorian — but the underlying storage is UTC midnight, so two users in different timezones / calendars see the same DAY.

**To set them**: open the task detail page → scroll to the **Dates** section → click any of the three pickers → choose a date → click **Save** under that picker. Each date is saved independently.

To clear a date, click **Clear** under it.

---

## Labels, subtasks, attachments, comments

On the task detail page:

- **Labels** — coloured tags scoped to the team (shared by tasks and projects). On a **task**, click **Add label**, pick from the dropdown (or create a new one with name + colour). Click an attached label's × to remove it. On a **project**, pick labels in the create/edit form; they appear as chips on the project list.
- **Subtasks** — ordered checklist. Add a title, hit Enter. Toggle the checkbox to mark done. Drag the handle to reorder. A subtask's `done` state doesn't auto-affect the parent task's status — toggling subtasks is just a per-step record.
- **Attachments** — drag-drop or click to upload files (≤ the upload limit your admin configured, default 10 MiB). Files download via authenticated links.
- **Comments** — free-text. Press Enter to post (Shift+Enter for newline). Use `@email-localpart` to mention a team member (e.g. `@alice` for `alice@example.com`) — they'll get a `MENTION` notification.

Comments and labels generate audit-log entries; subtask + attachment changes don't (deliberate to keep the activity feed readable).

### Custom fields (v1.58)

Team managers (or anyone granted **`customfield.manage`**) define reusable fields under **Settings → Custom fields**. Seven types are supported:

| Type | On the task |
|------|-------------|
| Text | Single-line text (up to 2000 characters) |
| Number | Decimal with up to four fractional digits |
| Date | Calendar date |
| Single select | Pick one option from a list you define (with optional colours) |
| Multi select | Pick one or more options |
| Checkbox | Yes / no |
| Person | A team member (picker lists roster members only) |

**Defining fields:** enter a name, choose a type, optionally mark **Required** or add select options (one per line when creating). Toggle **Active** off to stop new values without deleting historical data. Deleting a field removes all its values from tasks.

**Setting values:** open any task you can edit. The **Custom fields** section lists every active team field. Edit the control, click **Save**; click **Clear** to remove a value. Users with read-only project access see values but cannot change them. Required fields are enforced when you explicitly save a custom field value — existing tasks created before the field was added are **not** blocked from other edits.

Custom field changes appear in the task activity feed (`set … to …` / `cleared …`).

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

## Planner (v1.44)

The **Planner** hub (`/planner`) groups every way to *see* tasks without changing the underlying data. Open it from the sidebar **Planner** link (default landing: **My Tasks**). Tabs along the top:

| Tab | What it shows |
|-----|----------------|
| **My Tasks** | Every task **assigned to you** across all teams and projects. Board, Grid, or **week calendar** sub-views. Sort by due date, priority, status, or progress. Quick filters: Due today, Overdue, Upcoming, Completed, High priority, by project. Mark complete or open the project from board cards. |
| **Board** | Shortcut list of your projects — click one to open its kanban board with **Group by**. |
| **Calendar** | Cross-project date grid (see [Calendar views](#calendar-views) below). |
| **Charts** | Doughnut + bar charts: status mix, tasks per status, tasks per team member. Filter by team, project, **status**, **member**, and **due date range**. |
| **Grid** | Spreadsheet-style table: sort, filter (status, priority, assignee, label, dates), search, paginate. Resize columns; show/hide columns via **Columns**. Click a row to open the task; click project name to open the project board. |

> **Note:** Per-project "buckets" (custom column groups) were removed in v1.44. Use **Group by** on the board or **Labels** for similar organisation.

---

## Calendar views

The **Planner → Calendar** tab (`/planner/calendar`; `/calendar` redirects here) shows tasks from every project in the selected team(s) laid out on a date grid or timeline. Four view modes:

- **Work-week** — 5 cells starting on the first non-off-day. With Sat+Sun off, the first column is Monday; with Thu+Fri off, it's Saturday. The off-day setting drives both *which* 5 days appear and *where* the cursor lands.
- **Week** — 7 cells, Sunday-leading. Off-days are still tinted red.
- **Month** — full 6-week grid (42 cells). Days outside the current month are dimmed. Each cell shows up to 3 tasks + "+N more".
- **Timeline** (v1.47) — **Asana-style horizontal Gantt** across all projects in the selected team(s). Tasks appear as draggable bars from start → due (subtasks: start → end). Hierarchy: **Project → Task → Subtask** with expand/collapse. Toolbar: zoom (Day / Week / Month), Today, search, filters (project, assignee, status, date range). Drag a bar to shift dates; drag edges to resize. Bars show name, progress, assignee initials, and status colour. Unscheduled items appear in the sidebar without a bar.

Each task appears as a coloured pill — the pill colour is the **team accent** ([Team colours](#team-colours) above). Click the pill to jump to the task.

The **Date field** dropdown (Due vs Planned) applies to grid modes only — the Timeline view uses each task's start/due (or subtask start/end) range directly. Completed tasks are omitted from grid calendar fetches; the Timeline shows all non-deleted tasks (including done) so historical bars remain visible.

Off-days are determined by **weekend weekdays** ([Workweek](#workweek-off-days)) plus **instance holidays** ([Holidays](#holidays-admin)). Both render with a red label and red-50 background tint; holidays also show their **name** on hover.

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
- **Budget / cost (v1.73)** — per-project **planned** budget in each project's currency, plus a **team rollup grouped by currency** (IRR, EUR, and USD are never added together). Projects without `plannedBudget` show as "No budget". CSV export available. Read-only — project-level planned only (task budgets are separate; not rolled up here).
- **Overdue** — open tasks past their `dueDate`, oldest first.

Completion timestamps in reports use your timezone + time format; planned/due dates stay calendar-neutral.

### Exporting to CSV (v1.14)

Each report section (Tasks completed / Timeliness / Workload / **Budget** / Overdue) has an **Export CSV** button. Clicking it downloads a UTF-8 CSV with the section's data, named e.g. `tasks-done-7d-2026-05-24.csv`. The file opens cleanly in Excel, Numbers, and Google Sheets. The Summary widget is not exported on its own — its three numbers already live inside Workload / Tasks completed / Overdue.

---

## Configurable dashboards (v1.67)

**Dashboards** (`/dashboards`) let you build saved collections of chart widgets over a team's tasks. Pick the current team (same as Reports) from the team switcher.

### Creating and sharing

1. Click **Dashboards** in the left sidebar → **New dashboard**.
2. Name the dashboard; optionally tick **Shared with team** so every member can view it (only the owner or a team manager can edit).
3. Click **Add widget**, choose type → data source → group-by dimension → optional filters → **Save widget**.

### Widget catalog (v1)

| Type | Best for |
|------|----------|
| **Metric** | Single number (total task count or budget/custom-field sum) |
| **Bar** | Compare buckets side-by-side |
| **Pie / donut** | Share of whole (status, priority, select field, …) |
| **Line** | Tasks completed or created over time (day / week / month buckets) |
| **Table** | Raw bucket labels + counts |

**Data sources:** task count; sum of planned budget; sum of actual spent; sum of a **Number** custom field.

**Group by:** status, priority, assignee, label, project, due-date bucket (overdue / today / this week / later / no due date), or a **Single/Multi select** custom field.

**Filters (optional):** narrow by status, priority, assignee, label, project, or custom-field value before aggregating.

Charts use the same **Recharts** library as Planner charts. Under Persian (RTL), chart axes render left-to-right inside each widget for readability.

**Not in v1:** cross-team dashboards, click-through drill-down, scheduled email digests, custom SQL.

---

## Workload / capacity (v1.68)

**Workload** (`/workload`) shows each team member's open-task load with a due-date bucket breakdown. It calls `GET /api/teams/:teamId/reports/workload/detail` — an extension of the existing workload report, not a replacement. The legacy `GET /reports/workload` and `workload.csv` export are unchanged.

- **Due buckets:** overdue, this week (next 7 days from today UTC), next week (+7–14 days), later, no due date.
- **Filters:** project, due window (all / overdue / this week / next week).
- **Weighted mode:** totals use priority weights (Low=1, Medium=2, High=3, Urgent=4) instead of raw counts.
- **Capacity threshold:** a number you enter in the UI; members above it are highlighted in red (not stored server-side in v1).

Charts use Recharts stacked bars (`dir="ltr"` under RTL). Read-only — no task mutations.

**Deferred:** hour-level capacity, leave/PTO, story points.

---

## Intake forms (v1.69)

**Settings → Intake forms** lets managers build forms that create tasks in a chosen project. Team members submit at `/forms/:formId` inside the app.

- **Field targets:** title (required), description, priority, due date, assignee, labels, and any team custom field.
- **Default mode:** **Team members only** — authenticated submission.
- **Public mode (opt-in):** enables an opaque share link (`/public/forms/:token`). **Off by default.** Public forms accept anonymous submissions; anyone with the link can create tasks in the target project.

### Public form security

Treat public intake like the removed public registration endpoint (S-9): it is a deliberate, opt-in exposure surface.

- Enable public mode only when you need external submissions.
- **Rotate the link** if it leaks; the old URL stops working immediately.
- Public forms **cannot** include assignee or person custom fields (no team member list is exposed).
- Submissions are **rate-limited by IP** and include a **honeypot** field for bots.
- Tasks are created under the hidden system account, not the submitter.
- The public API returns only field labels and types needed to render the form — never team rosters or project internals.

Custom field values use the same server validators as in-app task editing — invalid values are rejected with 400.

---

## Notifications

The bell icon (top-right after sign-in) lights up when you have unread notifications. Types:

| Type | When it fires |
|------|---------------|
| `TASK_ASSIGNED` | You were assigned a task. |
| `TASK_DUE` | A task with you as assignee is due within your lead window (default 24 h; set on **Settings → Preferences**). Also fires for already-overdue tasks within a 30-day floor. When the admin enables **Skip off-days for due reminders**, a reminder that would land on a weekend/holiday is sent on the prior working day instead (or immediately if that moment is already past). |
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

## Display preferences (calendar / theme / language / time)

Per-user display settings on **Settings → Preferences**. Each travels with you across browsers + devices (stored on the server, mirrored into localStorage at every login). Saving reloads the page so every component picks up the new value cleanly.

### Calendar

- **Shamsi / Jalali** — Persian calendar, Persian digits, RTL date layout (e.g. `۱ خرداد ۱۴۰۵`). Default for new accounts on v1.10+ installs.
- **Gregorian** — Western calendar, English digits, ISO format (e.g. `2026-05-22`).

Affects how **calendar dates** render — due/start/planned dates, holidays, date picker labels. Storage is UTC midnight: two users in different timezones see the **same day** on a task due date.

**Dual calendar (v1.63):** optional switch shows both Jalali and Gregorian on key task dates (e.g. `۱۴۰۳/۰۱/۰۱ (2024-03-20)`).

### Timezone & time format (v1.63)

- **Timezone** — IANA name (e.g. `Asia/Tehran`). Applies to **timestamps only**: comment times, activity log, audit entries, created/updated labels, notification times. Leave unset to use your browser's zone.
- **12h / 24h** — how the clock portion of timestamps is shown. Default **24-hour** (Iran convention).

> **Important:** TaskHub stores two kinds of date field. **Calendar dates** (due, start, planned, holidays) are zone-neutral — everyone sees the same calendar day. **Timestamps** (createdAt, completedAt when shown as a moment, comments) are true instants converted to your chosen timezone for display. The database always keeps UTC; nothing shifts at storage time.

### Theme

Seven options on **Settings → Preferences** (v1.61). Your choice is stored on the server and mirrored to `localStorage` at login; the inline script in `index.html` applies it before first paint to avoid a flash.

| Preference | What you see |
|---|---|
| **Light** | Original TaskHub look (default). |
| **Dark** | Slate dark surfaces — same as pre-v1.61 Dark. |
| **System (auto)** | Follows your OS light/dark setting; updates live without reload. |
| **Midnight** | Deep blue-black palette. |
| **Solarized** | Warm cream / teal Solarized Light-inspired palette. |
| **High contrast** | Accessibility theme — black on white, WCAG AA contrast. |
| **Nord** | Cool Nord palette. |

Under the hood, the app sets a single `theme-*` class on `<html>` from a CSS-variable token system (`--color-bg`, `--color-text`, `--color-primary`, …). Tailwind utilities such as `bg-bg` and `text-text` read those tokens. Dark-family themes (Dark, Midnight, Nord, and System when the OS is dark) also keep Tailwind's legacy `dark` class so older `dark:` styles still work during migration.

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

The **Settings** link in the left sidebar opens the Settings shell. Sidebar items are ordered alphabetically by their English label (same order in the Persian UI). The items you see depend on your role:

- **Preferences** — everyone (personal calendar + theme + language + **due reminder lead time**). Admins additionally see the Workweek, Holidays, Working-day scheduling, and **Due reminders** sections.
- **Trash** — everyone (restore or purge soft-deleted projects and tasks).
- **Roles** — team role templates and permission matrix.
- **Labels** — team-scoped label management.
- **Custom fields** (v1.58) — team-scoped field definitions (Text, Number, Date, Single/Multi select, Checkbox, Person). Requires **`customfield.manage`** (default: team Manager). Define fields under **Settings → Custom fields**; set values on each task from the task detail page.
- **Security** — everyone (change password, 2FA). Global ADMIN additionally configures the **local password policy** (min length, complexity, lockout). Directory-linked accounts cannot change password here.
- **TaskHub** — global ADMIN only (public HTTPS/port, upload TLS certificate for Caddy).
- **Directories** — global ADMIN only (LDAP / SCIM config).
- **Audit** — global ADMIN or team MANAGER.
- **API & Webhooks** — everyone (tokens) + MANAGER (webhooks for that team).
- **Backups** — global ADMIN only (scheduled DB backups, download/restore).
- **Admin** — global ADMIN only (user accounts, instance management). **v1.52:** the user list supports search (name/email), filters (role, auth source, status, directory), sortable columns, and page-numbered navigation with total count. **v1.53:** lifecycle actions — disable/enable, unlock, force-logout, edit local profiles.

### Admin user list (v1.52)

**Settings → Admin → Users** — search by name or email (debounced), filter by role (Admin/Member), auth source (Local/LDAP/SCIM), account status (Active/Disabled/Locked), or directory. Click column headers to sort; use Previous/Next or jump to a page. Changing any filter returns to page 1. The hidden system account never appears in this list.

### Admin user lifecycle (v1.53)

From the user list, click **Manage** on a row to open the detail panel:

- **Disable / Enable** — disables the account and immediately revokes all active sessions (including group-granted access). Re-enabling clears the disabled flag; the user must sign in again for a new session. You cannot disable yourself or the last enabled Admin.
- **Unlock** — clears a lockout after too many failed logins (available when the account shows a Locked badge).
- **Force logout** — revokes all sessions without disabling the account. You cannot force-logout yourself.
- **Edit profile** — change name, email, department, and job title for **local** accounts only. LDAP/SCIM profiles are read-only (“Managed by {directory}”) because the next directory sync would overwrite local edits.

Disable and force-logout ask for confirmation. Status badges (Disabled, Locked) update in the list after each action.

Admin-only section on **Settings → Preferences**. Sets the instance-wide off-day set. Two one-click presets cover the common conventions:

- **Saturday + Sunday off (Western)**.
- **Thursday + Friday off (Iranian / Gulf)**.

An **Or pick custom days** disclosure lets you select any subset of the 7 weekdays (e.g. Friday-only, or a 3-day weekend). Saving reloads the page; every date picker in the app immediately paints the configured days in **red**, and the Calendar views tint those cells with a red-50 background.

The setting lives in the `InstanceSetting` key/JSON store (`calendar.weekend`), read publicly via `/api/system/info` so the date picker has the right colours before login.

### Holidays (admin)

**v1.62:** Admins can add **specific calendar dates** as instance-wide holidays (e.g. Nowruz / نوروز) — distinct from recurring weekend weekdays. Each holiday has a **name** and optional **yearly recurrence** (same month/day every year).

- **Settings → Preferences → Holidays** — add, edit, or delete holidays using the Jalali/Gregorian date picker (same as task dates).
- Holidays appear in **red** on the Calendar page, planner calendar, project Gantt, and timeline — alongside weekend off-days.
- Hover a holiday cell to see its name.
- Stored in the **`Holiday`** table at **UTC midnight** so every user sees the same calendar day regardless of browser timezone.

Non-admins can read holidays (for calendar colouring) but cannot create or delete them.

**v1.66 — Import Iranian holidays (admin):** Under **Settings → Preferences → Holidays**, use **Import Iranian holidays** to load official dates from a **bundled offline dataset** (no network — safe behind ISP filtering). Pick a **Jalali year**, click **Preview import** to see what would be added / skipped / conflict, then confirm. Imported rows are marked *imported*, fully **editable and deletable** afterward. Re-importing the same year is idempotent (no duplicates). **Manual holidays on the same date are never overwritten** — they appear as conflicts. **Important:** religious/lunar dates in the dataset may not match the latest official decree — always verify against government announcements and adjust individual rows after import. Refresh the bundled dataset yearly (`backend/scripts/generate-ir-holidays.mjs`).

### Working-day scheduling (admin, v1.64)

Two **opt-in** instance toggles under **Settings → Preferences → Working-day scheduling**. Both default **off** — when off, behaviour is identical to pre-v1.64 (calendar-day math everywhere).

| Setting | What it does |
|---|---|
| **Roll off-day due dates forward** | When a task **due date** (or a recurrence spawn's computed due date) lands on a weekend or holiday, store the **next working day** instead. Logs a `task.dueDate_rolled_offday` activity entry. |
| **Count working days only** | Recurrence `dueOffsetDays` / `plannedOffsetDays` and Gantt **duration counts** skip off-days. Bar positions on the chart still use calendar start/end dates. |

**Important policies:**

- **Not retroactive** — toggling a setting does not rewrite existing stored due dates. Rolls apply only on the next create, due-date edit, or recurrence spawn.
- **UTC midnight preserved** — all date math stays on UTC calendar-day anchors (same rule as task due dates).
- **Recurrence idempotency** — `spawnedForPeriod` is keyed on the template's spawn date, not the rolled due date, so rolling cannot collide with the unique constraint.

### Due reminders (v1.65)

**Personal lead time** — on **Settings → Preferences**, set **Due reminder lead time** (1–168 hours, default 24). The scheduler uses the **assignee's** value when set, otherwise the **creator's**, otherwise the server default (`TASK_DUE_LEAD_HOURS`, 24). Each task due date gets **one** `TASK_DUE` notification; `dueNotifiedAt` is stamped after send and reset only when the due date changes. Changing your lead time does **not** re-notify tasks already reminded.

**Skip off-days (admin)** — under **Settings → Preferences → Due reminders**, enable **Skip off-days for due reminders**. When the computed notify instant would fall on a weekend or holiday, TaskHub shifts it to the **prior working day** (same clock time). If that shifted moment is already in the past when the scheduler runs, the reminder fires **immediately** — still once per due date.

Per-task lead override is planned for a future release.

### Security — password policy (v1.43, admin)

Global **ADMIN** sees an extra section on **Settings → Security** for **local** accounts only (LDAP users follow your IdP's rules):

- Minimum length, require uppercase / lowercase / digit / symbol.
- Password history (prevent reuse of recent passwords).
- Lockout after N failed attempts for M minutes.

Members still use the same page to change their own password and manage 2FA. A strength indicator appears when typing a new password.

### TaskHub server (v1.43, admin)

**Settings → TaskHub** (global ADMIN):

- Set the **public port** and whether **HTTPS** is enabled.
- Upload **certificate**, **private key**, and optional **chain** for Caddy.
- View parsed cert details (subject, issuer, expiry).

After saving cert or port changes, restart the Caddy container so it picks up the new files. The UI reminds you of this step.

### Directories (LDAP)

Bind TaskHub to one or more LDAP servers so users log in with their LDAP credentials.

**To add an LDAP directory**:

1. **Settings → Directories → New directory**.
2. Fill the form:
   - **Name** + **slug** (URL-safe id).
   - **Host** + **port** — `389` with STARTTLS (typical for Active Directory) or `636` for LDAPS.
   - **Use TLS** / **TLS insecure** — for AD on port 389, enable TLS; if the server uses a private CA, enable *insecure* only when you accept skipping cert verification.
   - **Bind DN** + **bind password** — a read-capable service account.
   - **Base DN** — where users live (e.g. `ou=People,dc=example,dc=org`).
   - **Email attr** / **Name attr** / **User-ID attr** / **Group-member attr** — usually `mail`, `cn`, `uid`, `member` for OpenLDAP; `mail`, `cn`, `sAMAccountName`, `member` for AD.
   - **Allow JIT provisioning** — if checked, the first successful login auto-creates the local user row. If unchecked, only pre-created users can log in.
   - **Sync roles from groups** — apply group → role mappings on every login.
3. **Create**.
4. Click **Test** on the row to verify the bind works.

**Logging in (v1.43+):** users can enter either their **email** or their **LDAP username** (e.g. `sAMAccountName`) in the email field. Profile fields sync from LDAP on each successful login. The admin Directories panel shows auth source and sync status per imported user.

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

## Installing TaskHub as an app (PWA)

TaskHub ships as a **Progressive Web App (PWA)**. On a secure origin you can install it like a native app — it opens in its own window with the TaskHub icon and indigo theme bar.

**HTTPS required.** Browsers only offer install on **HTTPS** (or `localhost` during development). If your instance runs on plain HTTP (some internal deployments), TaskHub still works normally in a browser tab — install simply won't be offered. That is expected, not a bug.

### Desktop (Chrome / Edge)

1. Sign in at your TaskHub URL (must be `https://…`).
2. Look for the **install** icon in the address bar (⊕ or computer-with-arrow), or open the browser menu → **Install TaskHub** / **Apps → Install this site as an app**.
3. Confirm. TaskHub opens in a standalone window without browser tabs.

### Android (Chrome)

1. Open TaskHub over **HTTPS** and sign in.
2. Tap the browser menu → **Install app** or **Add to Home screen**.
3. The home-screen icon uses the TaskHub brand mark (maskable on Android so it isn't cropped).

### iOS (Safari)

1. Open TaskHub over **HTTPS** in Safari and sign in.
2. Tap **Share** → **Add to Home Screen**.
3. Confirm the name **TaskHub**. The icon comes from the apple-touch-icon asset.

**What the PWA caches.** Only the static app shell (HTML, JS, CSS, fonts, icons) is cached for faster launch. **Task and comment data is never cached** — every `/api/*` request goes to the server so you always see live data. There is no offline sync in v1.

After a server upgrade, the app updates automatically on the next visit (no manual cache clear).

**Admin notice on HTTP.** If your instance runs on plain HTTP, global admins see an amber warning on **About** explaining that the PWA cannot be installed until HTTPS is enabled. Regular members do not see this — it is operator guidance only. The notice uses the same secure-context check browsers use for install (`window.isSecureContext`), so it does not appear on HTTPS or localhost.

---

## Troubleshooting

**"I can't see Settings"** — the **Settings** link is shown to every signed-in user. If it's missing, refresh once (the bundle may be cached). If your global role just changed, sign out and back in.

**"My calendar choice doesn't stick"** — make sure the page reloaded after Save. If a cookie / localStorage block is in place (private mode, strict tracking-prevention), the choice falls back to Shamsi on the next visit.

**"My recurring task isn't spawning"** — the scheduler is opt-in. Ask your operator to set `RECURRENCE_ENABLED=true` in `.env` and `docker compose up -d backend`. Or hit `POST /api/teams/<teamId>/projects/<projectId>/tasks/<taskId>/recurrence/tick` manually to verify the rule itself is correct.

**"My webhook fires but the receiver rejects the signature"** — confirm the receiver computes `sha256` HMAC over the **raw body bytes** (not the parsed JSON), keyed with the secret shown at creation, and compares the hex digest against the part of `X-TaskHub-Signature` after `sha256=`.

**"LDAP login says 'Invalid credentials' but the password works elsewhere"** — check: (1) local user row pre-existing with `directoryId=null` — delete the conflicting row so JIT can recreate; (2) AD on port 389 needs **Use TLS** (STARTTLS); (3) try logging in with **username** instead of email if UPN differs from `mail`; (4) private-CA servers may need **TLS insecure** temporarily. Admin can verify bind with **Test** on the directory row.

**"I lost my 2FA device and my recovery codes"** — ask a global ADMIN to log into the database and clear `totpEnabled` + `totpSecretEnc` for your row. There's no self-service "I lost everything" flow by design — that would defeat 2FA.

**"The bell isn't updating in real time"** — the WebSocket connects on page load. If you've left the tab open across a server restart, the connection drops; refreshing reconnects.

**"I don't see Install TaskHub"** — install is only offered on **HTTPS** (or `localhost`). Plain HTTP instances work as a normal website; ask your operator for an HTTPS URL if you want the standalone app.

---

*Need something not covered here? Check `CHANGELOG.md` for the per-version surface, `ARCHITECTURE.md` for the design rationale, or open an issue.*
