# Directory Sync — Design Document

**Status:** Draft for approval · **Phase:** 0a of the Access & Organization Redesign
**Author:** Naser Fathi · **Date:** 2026-07-18 · **Baseline:** v2.5.59

This document specifies the scheduled directory synchronisation job. It is a prerequisite
for Phase 1C (unit-scoped assignment) and Phase 4 (org membership), and must be approved
before implementation begins.

---

## 1. Why this exists

Group mapping is applied **at login only**. `authService.applyDirectoryGroups`
(`backend/src/services/authService.ts:385`) is called from exactly two places — the JIT
provisioning path (`:303`) and the LDAP profile-sync path (`:335`) — both of which run
inside a sign-in.

The consequence: **a user who has not signed in since a mapping was entered has no team
membership derived from that mapping.** Under Phase 1C's unit-scoped assignment, such a
user also has no unit, and therefore no supervisor can assign them work.

The population least likely to have signed in recently is exactly the site crews this
programme exists to serve. Login-time-only mapping is therefore not a gap to tolerate — it
is the specific failure this phase removes.

**Objective.** Evaluate `DirectoryGroupMapping` for *all* directory users on a schedule,
independent of login activity, with a per-run summary in which conflicts are reported
errors and never silent picks.

---

## 2. What already exists

| Capability | Where | State |
|---|---|---|
| LDAP connect, bind, StartTLS/LDAPS | `ldapService.ts` (`openClient`, `withClient`) | Usable as-is |
| Single-user profile search by identifier | `ldapService.authenticate` / `searchUserProfile` | Usable as-is |
| Profile fetch by DN | `ldapService.fetchUserProfile` | Usable as-is |
| Per-user group search | `ldapService.fetchGroups` | Usable, but see §4.2 |
| Mapping evaluation | `authService.applyDirectoryGroups` | Reused, with corrections — §5 |
| DN comparison helpers | `lib/ldapDn.ts` | Usable, with one defect — §5.5 |
| Mapping storage | `DirectoryGroupMapping` (`schema.prisma:353-374`) | Usable |
| Scheduler pattern | `scheduler/backupScheduler.ts` et al. | Pattern to copy |

### Capability gaps this phase must close

1. **No bulk user enumeration.** `ldapService` can only look users up one at a time, by
   identifier or by DN. There is no method that walks a directory.
2. **No paged search.** No LDAP paged-results control anywhere in the file. The only
   bounding is `sizeLimit: 2` (ambiguity detection) and `sizeLimit: 5` (connection test).
   Active Directory caps a single response at `MaxPageSize` — 1000 by default — so an
   unpaged enumeration silently truncates. **Silent truncation in a sync job is the worst
   possible failure mode: it looks like success and quietly de-provisions people.**
3. **No sync state on `Directory`.** No `lastSyncAt`, no status, no summary
   (`schema.prisma:279-315`).

---

## 3. Scope

**In scope.** Scheduled evaluation of `DirectoryGroupMapping` for all users of every
LDAP-kind directory: global role, team membership, and team role. Dry-run mode. A
machine-readable run summary. Admin-triggered manual run.

**Out of scope.** Unit membership (Phase 1A defines the schema; this job gains a mapping
pass in Phase 1C). Org membership (Phase 4 extends this job). SCIM directories —
`scimService.ts` maintains memberships through its own independent path and is not touched
here. Password or credential synchronisation of any kind.

---

## 4. Scan design

### 4.1 Directory-driven, not database-driven

Two candidate designs:

- **(A) Iterate local users** where `directoryId` is set, and refresh each.
- **(B) Enumerate the directory**, provision users that are missing locally, then apply
  mappings.

**Design (A) is rejected.** It can only reach users who already exist in the local
database — that is, users who have already logged in or been SCIM-provisioned. It
therefore does not solve the problem stated in §1 at all. It would produce a job that
appears to work while leaving precisely the affected population untouched.

**Design (B) is adopted.** The scan is authoritative from the directory's side.

### 4.2 Two passes, and why

**Pass 1 — paged user enumeration.** One paged search per directory over `baseDN`, scoped
`sub`, filtered by `userFilter`, requesting the profile attributes plus `memberOf`. This
yields the complete user set *and* each user's group DNs in a single traversal.

**Pass 2 — mapped-group member expansion (supplement).** `memberOf` is an Active Directory
back-link. OpenLDAP with `groupOfNames` does not populate it unless the `memberof` overlay
is configured. So for each **distinct `externalGroupDn` that appears in
`DirectoryGroupMapping`**, search that group entry once and read its `groupMemberAttr`
members.

Pass 2 is bounded by the number of *mappings*, not the number of *users* — typically
single digits. This matters: the naive alternative is to call `fetchGroups` per user, and
`fetchGroups` issues an **unbounded subtree search** with no `sizeLimit`
(`ldapService.ts`, the `fetchGroups` search). Doing that once per user would mean N
unbounded subtree searches per run. For a 2,000-user directory that is a denial of service
against your own domain controller.

The two passes are merged per user with the existing `mergeGroupDns` helper
(`lib/ldapDn.ts`), which already dedupes by normalised DN and preserves first-seen casing.

Pass 2 is skippable per directory via a config flag for installations where `memberOf` is
known-good, but **defaults to on** — a missing group is an under-grant, and under-grants
are the failure that blocks assignment.

### 4.3 Pagination

`ldapts` supports the paged-results control via the `paged` search option. Page size is
configurable (`DIRECTORY_SYNC_PAGE_SIZE`, default 500 — comfortably under AD's default
`MaxPageSize` of 1000).

**Truncation must be loud.** If the server returns a result set without a paging cookie
when one was expected, or the accumulated count reaches `DIRECTORY_SYNC_MAX_USERS`, the
run **aborts with an error** and applies no writes. It does not process a partial set.
Partial processing plus a revocation rule equals mass de-provisioning.

### 4.4 Cadence

Default **daily** (`DIRECTORY_SYNC_INTERVAL_MIN`, default `1440`), off by default, matching
the repo convention for background jobs (`env.ts`, `BACKUP_ENABLED` and friends all default
`'false'`).

Daily rather than hourly because: the job's purpose is JML propagation, whose real-world
latency is already measured in days; a full directory walk is materially more expensive
than the existing minute-scale jobs; and login-time mapping continues to work unchanged, so
an active user is still synced at every sign-in. The scheduled job is the safety net for
the *inactive* user, and a daily net is sufficient.

Following `backupScheduler.ts`, **the job does not run immediately on `start()`** — a
boot-time directory walk would contend with `prisma migrate deploy` during a deploy.

### 4.5 Overlap guard — a new pattern for this repo

No existing scheduler guards against a tick outrunning its interval; they rely on
idempotence and DB markers instead. A full directory scan against a slow or unreachable
domain controller can plausibly exceed even a daily interval, and concurrent runs would
race on the same memberships.

This job therefore introduces an explicit re-entrancy flag:

```ts
let running = false;
async function tick(): Promise<SyncSummary> {
  if (running) {
    opts.logger.warn({}, 'directory sync skipped — previous run still in progress');
    return skippedSummary();
  }
  running = true;
  try { /* ... */ } finally { running = false; }
}
```

Flagged explicitly because it is new for this codebase and reviewers should not assume it
was copied from an existing scheduler.

**Multi-replica warning.** Like every other scheduler here, this must be enabled on exactly
one node. The flag is per-process and provides no cross-replica mutual exclusion.

---

## 5. Conflict policy

The programme requires that *conflicts are reported errors, never silent picks*. The
current implementation violates this in several places. Each is specified below.

### 5.1 Conflicting global roles — behaviour change

**Today:** `applyDirectoryGroups` takes the highest-ranking matched role, ADMIN over
MEMBER, silently. A user in two mapped groups — one granting ADMIN, one granting MEMBER —
becomes ADMIN with no record that a choice was made.

**Under sync:** a user matching mappings that specify *different* `globalRole` values is a
`GLOBAL_ROLE_CONFLICT`. The job **makes no global-role change for that user** and records
the conflict with both mapping IDs. The existing role is left untouched.

Rationale: at login the stakes are one interactive user and an admin is present to notice.
In an unattended nightly job that can touch every account, "highest wins" is a silent
privilege-escalation path.

### 5.2 Conflicting team roles for the same team

**Today:** the per-mapping `for` loop upserts each matched mapping in turn, so for two
mappings targeting the same `teamId` the last one processed wins — and the order is
`findMany`'s unspecified default.

**Under sync:** two matched mappings targeting the same `teamId` with different `teamRole`
or different `roleId` is a `TEAM_ROLE_CONFLICT`. That **team is skipped** for that user;
other teams still apply. Reported with user, team, and both mapping IDs.

### 5.3 Dangling mapping targets

`DirectoryGroupMapping.teamId` is **a bare string with no foreign key**
(`schema.prisma:353-374`) — validated only in application code at creation time. A team
deleted afterwards leaves a mapping pointing at nothing.

The job resolves and caches all referenced team IDs **once at the start of a run**. Any
mapping whose `teamId` no longer resolves is reported as `MAPPING_TARGET_MISSING` and
skipped. This is a run-level warning, not a per-user one — it is reported once, not once
per affected account.

### 5.4 Identity collisions

A directory entry whose email matches an existing local user with a different
`authSource`, or with a different `directoryId`, is an `IDENTITY_COLLISION`. The job
**never merges accounts**; it reports and skips. Account merging is an administrative
decision with an audit trail, not something a nightly job infers.

### 5.5 DN normalisation collision — a defect to fix

`normalizeLdapDn` (`backend/src/lib/ldapDn.ts:5`) is:

```ts
return dn.trim().replace(/\s+/g, '').toLowerCase();
```

`\s+` strips **all** whitespace, including whitespace inside attribute values — not just
the optional spaces around RDN separators that the comment describes. Therefore:

```
CN=Ops Team,OU=Groups,DC=example,DC=com   →  cn=opsteam,ou=groups,dc=example,dc=com
CN=OpsTeam,OU=Groups,DC=example,DC=com    →  cn=opsteam,ou=groups,dc=example,dc=com
```

Two distinct AD groups normalise to the same key. `groupDnsMatch` would match a user in
either group against a mapping for the other, granting access to the wrong team.

At login this affects one user at a time and has evidently not been noticed. **A scheduled
job applies it to the entire directory every night**, so it must be fixed before the job
ships, not after.

**Fix:** normalise only the separators, preserving intra-value whitespace:

```ts
export function normalizeLdapDn(dn: string): string {
  return dn
    .trim()
    .split(',')
    .map((rdn) => rdn.trim().replace(/\s*=\s*/, '='))
    .join(',')
    .toLowerCase();
}
```

Two details of that fix are deliberate. The `=` replace is **not** global — only the first
`=` in an RDN separates the attribute type from its value, and a later one belongs to the
value. And splitting on `,` still does not honour RFC 4514 escaping, so a DN with an
escaped comma inside a value (`CN=Smith\, John,OU=…`) is split into bogus RDNs. That is a
pre-existing limitation, not a regression — but it means the fix is a correction, not a
conforming DN parser. The 0d-ii report emits `MAPPING_DN_ESCAPED` if any configured mapping
contains an escaped comma; if the estate has none, a full parser is unnecessary, and if it
has any, `lib/ldapDn.ts` needs one before this job can be trusted with those mappings.

**Detection, additionally:** at the start of every run the job normalises all configured
`externalGroupDn` values and reports `MAPPING_DN_COLLISION` if two distinct raw DNs
collide. This is cheap and catches the class of problem rather than only this instance.

> This change alters matching behaviour for existing installations. Any mapping that was
> silently matching the wrong group stops matching. That is the correction, but it must be
> called out in the release notes, and the first run after deployment should be a dry run
> (§7) so the diff is inspected before it is applied.

### 5.6 Conflict summary

| Code | Trigger | Action |
|---|---|---|
| `GLOBAL_ROLE_CONFLICT` | Matched mappings disagree on `globalRole` | No global-role change for that user, **and no demotion** |
| `TEAM_ROLE_CONFLICT` | Matched mappings disagree for one `teamId` | Skip that team for that user |
| `MAPPING_TARGET_MISSING` | Mapping `teamId` or `roleId` does not resolve | Skip mapping, report once per run |
| `MAPPING_DN_ESCAPED` | Mapping DN contains an RFC 4514 escaped comma | Skip that mapping |
| `USER_MISSING_EMAIL` | Directory entry has no usable mail attribute | Skip user, never provision |
| `MAPPING_DN_COLLISION` | Two mappings normalise to one DN | Abort the directory's run |
| `IDENTITY_COLLISION` | Email matches a user of another source | Skip user, never merge |
| `LAST_ADMIN_PROTECTED` | Demotions would leave zero global admins | Apply none of them |
| `TRUNCATED_ENUMERATION` | Paging incomplete or cap reached | Abort the directory's run, no writes |

`MAPPING_DN_COLLISION` and `TRUNCATED_ENUMERATION` abort rather than skip, because both mean
*the input set is not trustworthy*, and every downstream decision — especially revocation —
depends on the input set being complete.

**`GLOBAL_ROLE_CONFLICT` must not be conflated with "no mapping grants a role."** Both leave
the desired role null, but they mean opposite things: the second is a revocation signal, the
first must produce no change at all. Collapsing them lets a conflict demote an administrator,
which is precisely the silent privilege change this policy exists to prevent. The
implementation tracks the conflict separately for this reason, and there is a regression test
pinning it.

**`USER_MISSING_EMAIL` exists because of a bulk-path asymmetry.** `profileFromEntry` falls
back to its identifier argument when the mail attribute is absent. At login that identifier is
what the user typed — reasonable. In bulk enumeration it is the DN, which would be written
straight into `User.email`, a unique column the rest of the application treats as an address.
Service accounts and computer objects that slip past `userFilter` are the usual source.

---

## 6. Revocation policy

This is the highest-risk decision in the design and is called out for explicit approval.

### 6.1 Team membership — revocation already happens

`applyDirectoryGroups` computes `mappedTeamIds - desiredTeamIds` and issues a `deleteMany`.
Removal is scoped to teams referenced by *some* mapping on the directory, so teams managed
manually are untouched. **This behaviour is correct and is preserved unchanged.**

Preserving it has one non-obvious consequence worth stating, because the natural
implementation gets it wrong: **a user who matches no mapping at all must still be
processed.** That is the full-leaver case — somebody removed from every mapped group — and
it is the primary joiner/mover/leaver event this job exists to propagate. Returning early on
"no mappings matched" would leave their memberships in place forever, making the scheduled
job *weaker* than the login path it backstops, since the login path already computes
`toRemove` as the whole mapped set when nothing matches. Only *provisioning* is declined for
an unmatched user, since there would be nothing to grant them. There is a regression test.

### 6.2 Global role — revocation does not happen, and should not start silently

The current code updates `globalRole` **only when a matched mapping supplies one**. If a
user is removed from the group that made them ADMIN, `newGlobal` is `null` and the update
is skipped: **losing the group never demotes you.** Global ADMIN, once granted by mapping,
is permanent until changed by hand.

That is a real access-review finding — ISO 27001 A.5.16 expects leaver and mover events to
propagate — and the sync job is the natural place to fix it.

It is also the single most dangerous thing this job could do. A misconfigured `baseDN`, a
`userFilter` typo, or a domain controller returning an empty page could demote every
administrator in one unattended run.

**Specified behaviour:**

1. Global-role revocation is **off by default**, behind `DIRECTORY_SYNC_REVOKE_GLOBAL_ROLE`.
2. When enabled, it applies **only** to users whose `authSource` is this directory. Local
   users are never demoted by a directory job.
3. It is **suppressed entirely** for any run that recorded a `TRUNCATED_ENUMERATION` or
   `MAPPING_DN_COLLISION` — no revocation on an untrusted input set.
4. **Last-admin interlock:** the job will not reduce the number of active global ADMIN
   users below one. If a run would do so, it demotes none of them and reports
   `LAST_ADMIN_PROTECTED`.
5. Every demotion is written to the audit log with the run ID as its cause.

Recommendation: ship with the flag off, run in dry-run for two weeks, review the demotions
the job *would* have made, then enable.

### 6.3 Atomicity

`applyDirectoryGroups` currently issues the global-role update, the per-team upserts, and
the `deleteMany` as **separate statements with no transaction**. A failure midway leaves a
user half-applied, and a concurrent login for the same user can interleave.

The sync path wraps each user's mutations in a single `prisma.$transaction`. Per user, not
per run — a directory-wide transaction would hold locks for the length of the scan.

---

## 7. Dry-run mode

`runOnce({ dryRun: true })` performs the full scan and all conflict detection, computes
every intended mutation, and **writes nothing**. It returns the same summary shape as a
live run, with each intended change enumerated.

Dry run is not a convenience. It is:

- the rehearsal mechanism the programme requires before enabling revocation (§6.2);
- the way the §5.5 DN fix is validated against production data before it applies;
- the engine behind the Phase 0d coverage report, and later the Phase 1C unit-coverage
  exception report — the report and the job must not be two implementations that can
  disagree.

`DIRECTORY_SYNC_DRY_RUN=true` forces dry run globally, so the job can be scheduled in
observation mode in production.

---

## 8. Run summary

Every run returns and logs a structured summary. It is the ISO A.5.16 evidence artifact.

```ts
interface DirectorySyncSummary {
  runId: string;                  // cuid, correlates audit-log entries
  startedAt: Date;
  finishedAt: Date;
  dryRun: boolean;
  directories: DirectorySyncDirectoryResult[];
}

interface DirectorySyncDirectoryResult {
  directoryId: string;
  directorySlug: string;
  status: 'OK' | 'ABORTED' | 'SKIPPED';
  abortReason?: string;

  usersEnumerated: number;        // returned by the directory
  usersMatched: number;           // matched >= 1 mapping
  usersUnmatched: number;         // matched none — the coverage gap
  usersProvisioned: number;       // created locally this run
  membershipsAdded: number;
  membershipsUpdated: number;
  membershipsRemoved: number;
  globalRolesChanged: number;

  conflicts: DirectorySyncConflict[];
}

interface DirectorySyncConflict {
  code: 'GLOBAL_ROLE_CONFLICT' | 'TEAM_ROLE_CONFLICT' | 'MAPPING_TARGET_MISSING'
      | 'MAPPING_DN_COLLISION' | 'IDENTITY_COLLISION' | 'LAST_ADMIN_PROTECTED';
  message: string;
  userId?: string;
  externalId?: string;
  teamId?: string;
  mappingIds?: string[];
}
```

`usersUnmatched` is the number the programme actually steers by: it is the population that
will have no unit under Phase 1C, and its decline to zero is the Phase 1C entry gate.

**Logging** follows the repo convention — pino object-first, errors under `err`, metrics in
the object and not the message, and silence when there is nothing to report:

```ts
opts.logger.info({ runId, directories: n, usersMatched, usersUnmatched, conflicts: c.length },
                 'directory sync completed');
```

A run with any conflict logs at `warn`; an aborted run logs at `error`.

---

## 9. Schema changes

Additive only, one migration.

```prisma
model Directory {
  // ... existing fields unchanged ...

  /// v2.6: scheduled sync. Independent of `syncRolesFromGroups`, which gates
  /// login-time mapping — a directory can be sync-enabled without changing
  /// login behaviour, and vice versa.
  syncEnabled       Boolean   @default(false)
  /// Skip pass 2 (mapped-group member expansion) when memberOf is known-good.
  syncTrustMemberOf Boolean   @default(false)
  lastSyncAt        DateTime?
  lastSyncStatus    String?   // 'OK' | 'ABORTED' | 'SKIPPED'
  lastSyncSummary   Json?     // DirectorySyncDirectoryResult
}
```

`syncEnabled` is deliberately separate from `syncRolesFromGroups`. Overloading the existing
flag would silently switch on a nightly directory walk for every installation that had
enabled login-time mapping — a behaviour change on upgrade, which this design does not
accept.

No changes to `DirectoryGroupMapping`. Adding the missing `teamId` foreign key is
worthwhile but is a separate, non-additive migration with its own backfill of dangling
rows; §5.3 handles the consequence in the meantime.

---

## 10. Environment configuration

None of these exist today. All follow the established patterns in `config/env.ts`: booleans
as `.string().default('false').transform(v => v === 'true')`, durations as
`z.coerce.number().int().positive().default(N)` with the unit in the name.

| Variable | Default | Purpose |
|---|---|---|
| `DIRECTORY_SYNC_ENABLED` | `false` | Master switch. Enable on exactly one node. |
| `DIRECTORY_SYNC_INTERVAL_MIN` | `1440` | Scan cadence. |
| `DIRECTORY_SYNC_PAGE_SIZE` | `500` | LDAP paged-results page size. |
| `DIRECTORY_SYNC_MAX_USERS` | `10000` | Per-directory safety cap; exceeding it aborts. |
| `DIRECTORY_SYNC_DRY_RUN` | `false` | Force observation mode globally. |
| `DIRECTORY_SYNC_REVOKE_GLOBAL_ROLE` | `false` | Enable global-role demotion (§6.2). |
| `DIRECTORY_SYNC_TIMEOUT_SEC` | `300` | Per-directory wall-clock budget; exceeding it aborts that directory. |

Mirrored into `.env.example` under a `# --- Directory sync (v2.6) ---` header.

---

## 11. Surfaces

**Scheduler.** `backend/src/scheduler/directorySyncScheduler.ts`, matching the established
factory shape: `createDirectorySyncScheduler(opts)` returning `{ start, stop, runOnce }`,
with `runOnce(opts?: { dryRun?: boolean }) => Promise<DirectorySyncSummary>`. Constructed
in `server.ts` behind `env.DIRECTORY_SYNC_ENABLED`, stopped in **both**
`app.lifecycle.stopBackground` and the SIGINT/SIGTERM handler.

**Service.** The scan logic lives in `backend/src/services/directorySyncService.ts`, not in
the scheduler. The scheduler tick stays thin. This follows the repo's own precedent —
`recurrence.test.ts` tests the service directly rather than through the scheduler — and it
is what makes §12 testable without a live LDAP server.

**LDAP.** New `LdapService.enumerateUsers(directory, opts): AsyncIterable<LdapAuthResult>`
implementing the paged search, and `LdapService.fetchGroupMembers(directory, groupDn)` for
pass 2. Existing methods unchanged.

**Route.** `POST /api/settings/directories/:directoryId/sync`, body `{ dryRun?: boolean }`,
behind the same guards as every other directory route (`requireAuth`, `requireGlobalAdmin`,
`requireScope('admin')`). Returns the summary. Gives admins a rehearsal button and makes
the job testable in staging without waiting a day.

**Frontend.** A sync panel on the existing directories settings page: last run time, status,
the counts, the conflict list, and dry-run / run-now buttons. Read-only detail; no
conflict-resolution UI in this phase.

---

## 12. Testing

Following the repo's scheduler-test convention — `runOnce` called directly, `intervalMin:
9999`, `fakeLogger()`, never starting a timer, and asserting idempotency by calling twice.

The `LdapService` is injected, so the suite substitutes a fake directory and needs no live
server. `directoryGroupMappings.test.ts` already drives `applyDirectoryGroups` this way.

Required cases:

1. Users who have **never logged in** receive memberships. *This is the test that proves
   the phase's purpose.*
2. Idempotency — a second consecutive run reports zero changes.
3. Each conflict code in §5.6 produces the conflict and applies the specified action.
4. Truncated enumeration aborts and writes nothing.
5. Revocation is suppressed on an aborted run.
6. Last-admin interlock holds when the flag is on.
7. Dry run writes nothing — asserted by snapshotting the affected tables before and after.
8. DN collision detection fires on `CN=Ops Team` vs `CN=OpsTeam`, and the corrected
   normaliser distinguishes them.
9. **Negative tenancy test:** a mapping for team A never produces a membership in team B —
   the house rule for every feature.
10. A SCIM-kind directory is skipped entirely.

---

## 13. Rollout

1. Ship with `DIRECTORY_SYNC_ENABLED=false`. Migration is additive and inert.
2. Deploy the §5.5 DN fix in the same release, with release-note callout.
3. Enable on one node with `DIRECTORY_SYNC_DRY_RUN=true`. Review summaries daily.
4. Compare `usersUnmatched` against the Phase 0d coverage report — the two must agree.
   Disagreement means one of them is wrong, and it must be resolved before proceeding.
5. Turn off dry run. Watch `membershipsRemoved` on the first live run especially.
6. After two clean weeks, consider `DIRECTORY_SYNC_REVOKE_GLOBAL_ROLE`.

**Phase 0 exit criterion:** seven consecutive days of scheduled runs in production with zero
unexplained conflicts in the summary.

---

## 14. Open questions

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| Q-1 | Enable global-role revocation (§6.2)? | Not Phase 0 — can follow | Ship off; decide after two weeks of dry-run evidence |
| Q-2 | Does the AD estate populate `memberOf` reliably? If yes, pass 2 can default off and the scan gets materially cheaper | Tuning only, not correctness | Leave pass 2 on until measured |
| Q-3 | D-3 (AD anchor: security groups / OU DNs / attributes) shapes whether Phase 1C's unit pass extends `DirectoryGroupMapping` or needs its own table | Phase 1A schema, not this job | Security groups — matches the existing DN-keyed shape |
| Q-4 | Add the missing `teamId` foreign key on `DirectoryGroupMapping`? | Independent | Yes, as its own migration with a dangling-row backfill |

Nothing in this table blocks implementation of the job as specified.
