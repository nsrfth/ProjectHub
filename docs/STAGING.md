# Staging Environment — Runbook

**Status:** Phase 0c of the Access & Organization Redesign · **Decision D-6:** adopt
**Version:** v2.6 · **Date:** 2026-07-18

Staging exists for one concrete reason: two upcoming phases cannot be safely rehearsed
anywhere else.

- **Phase 2** rewrites `resolveProjectAccess`, which is consulted on effectively every
  authenticated request. A bad `dual → on` flag transition is a total-loss-of-authorization
  event, and its exit criteria require a backfill rehearsed on a production snapshot
  restore, completing idempotently twice.
- **Phase 5** materialises grants in bulk at project creation. A bad policy is a
  data-cleanup incident, not a flag flip. Its exit criteria require a deliberately
  mis-scoped policy to be tried and its blast radius observed.

Neither is a thing you do in production first.

---

## 1. Principles

**Staging is a separate stack, not a profile.** Compose profiles share the file's volume
namespace. A `staging` profile alongside production on one host would share
`postgres_data`. The overlay therefore requires an explicit project name.

**Staging holds production data.** That is the point — a rehearsal against synthetic data
does not de-risk a backfill. It follows that staging is as sensitive as production and is
treated that way: same network restrictions, same access control, secrets rotated so a
staging leak is not a production leak.

**Nothing in staging reaches the outside world.** Every scheduler is off by default in the
overlay. The failure this prevents is concrete: a reminder scheduler running against
restored production data emails real people about real tasks.

---

## 2. Bring it up

```bash
cp .env .env.staging      # then edit — see §3, DO NOT skip the secret rotation
docker compose -p taskhub-staging \
  --env-file .env.staging \
  -f docker-compose.yml -f docker-compose.staging.yml \
  up -d --build
```

`-p taskhub-staging` is mandatory. Without it Compose resolves `postgres_data` to the
production stack's volume, and you have pointed a second backend at the live database.

Verify the isolation before you trust the stack:

```bash
docker volume ls | grep taskhub-staging   # must show its OWN postgres_data
docker compose -p taskhub-staging ps
```

Reachable on `http://<host>:8080` (override with `STAGING_HTTP_PORT`).

---

## 3. `.env.staging` — what must differ

| Variable | Why it must change |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | A staging token must not be valid in production. |
| `MASTER_KEY` | Encrypts LDAP bind passwords. Sharing it means a staging compromise yields the production directory credential. **See §4 — changing it makes restored ciphertext unreadable, which is intended.** |
| `POSTGRES_PASSWORD` | Separate database, separate credential. |
| `SITE_HOST`, `PUBLIC_APP_URL` | Otherwise password-reset links in staging point at production. |
| `SMTP_HOST` | Leave empty. `mailer.isEnabled()` goes false and every composer becomes a no-op. |
| `TASKHUB_VERSION` | Set to `staging` so the About page and logs identify the environment. |
| `UPDATER_URL`, `UPDATER_TOKEN` | Leave empty. Staging must not self-upgrade. |

---

## 4. Restoring a production snapshot

This is the procedure Phase 2's exit criteria depend on.

```bash
# 1. On production — take a dump. Use the existing backup machinery.
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > prod-snapshot.dump

# 2. Copy to the staging host, then restore into the STAGING stack.
docker compose -p taskhub-staging exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < prod-snapshot.dump

# 3. Apply any migrations the snapshot predates.
docker compose -p taskhub-staging exec backend npx prisma migrate deploy
```

### Sanitise immediately after restoring

The restore brings real people, real email addresses, and encrypted directory credentials.
Run this before anyone touches the stack:

```sql
-- Neutralise outbound reachability. Emails are already no-ops with SMTP_HOST
-- empty, but defence in depth: if someone sets SMTP_HOST to debug something,
-- this is what stands between them and mailing the whole company.
UPDATE "User" SET email = 'staging+' || id || '@invalid.local' WHERE email NOT LIKE '%@invalid.local';

-- Invalidate every session carried over from production.
DELETE FROM "RefreshToken";

-- Directories: the bind ciphertext was encrypted with production's MASTER_KEY
-- and is unreadable here by design. Clear it so a connection attempt fails
-- loudly rather than throwing a decrypt error, and make sure no restored
-- directory is left sync-enabled.
UPDATE "Directory" SET "bindPasswordEnc" = NULL, "syncEnabled" = false;
```

Then create a fresh local admin to log in with, since every restored account now has an
`@invalid.local` address.

> **Note on password hashes.** Restored `passwordHash` values remain valid — argon2 does
> not depend on `MASTER_KEY`. Anyone who knows a production password can log into staging
> with the rewritten email. This is acceptable only because staging is access-restricted;
> if that stops being true, add `UPDATE "User" SET "passwordHash" = NULL;` to the block
> above and use the local admin exclusively.

---

## 5. Rehearsing the directory sync (Phase 0a)

The overlay pins `DIRECTORY_SYNC_DRY_RUN=true`. Leave it pinned. To rehearse:

1. Re-enter a bind password for the directory in Settings → Directories — the restored
   ciphertext was cleared in §4 and cannot be decrypted here anyway.
2. Set `DIRECTORY_SYNC_ENABLED=true` in `.env.staging` and recreate the backend.
3. Use the admin endpoint for an immediate run rather than waiting for the interval:
   `POST /api/settings/directories/:id/sync` with `{ "dryRun": true }`.
4. Read the summary. The numbers that matter: `usersUnmatched` (the Phase 1C coverage
   gap), `membershipsRemoved` (a surprise here means a mapping is wrong), and every entry
   in `conflicts`.
5. Cross-check `usersUnmatched` against `npm run report:directory-coverage`. **They must
   agree.** If they do not, one of them is wrong, and that must be resolved before the job
   is trusted in production.

---

## 6. Phase-entry checklist

Staging is ready to gate Phase 2 when all of these hold:

- [ ] Stack runs under its own project name with its own volumes — verified, not assumed
- [ ] A production snapshot has been restored and sanitised at least once end to end
- [ ] `prisma migrate deploy` applies cleanly against the restored snapshot
- [ ] Every scheduler confirmed off (`docker compose -p taskhub-staging exec backend env | grep ENABLED`)
- [ ] The e2e smoke suite (Phase 0b) passes against the staging URL
- [ ] Secrets confirmed different from production — no shared JWT secret, no shared master key

---

## 7. What staging does not give you

It does not reproduce production **load**, so it will not surface a resolver-rewrite
performance regression. That risk stays live and is covered instead by the staged flag walk
(`off → dual → on`) with divergence logging, plus a low-usage transition window.

It also does not replace the observability floor named in risk R-4. Staging tells you
whether a change *works*; it does not tell you whether production has *noticed* it break.
Those are different gates and Phase 2 needs both.
