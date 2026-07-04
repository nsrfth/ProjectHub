# Ops scripts

Host-side operational scripts for a Docker-Compose ProjectHub deployment. Run
them from the box that runs the stack (they talk to it via `docker compose`).

## Backups: the full picture

1. **In-app scheduler** (built in, v1.27+): writes dumps into the
   `backups_data` volume (`/app/backups`) on a schedule. Enable with
   `BACKUP_ENABLED=true` in `.env`. This is *on-box* only — it does **not**
   protect against losing the box.
2. **`offsite-backup.sh`** (W4): ships the newest dump off the box to an
   offsite destination (rclone remote or rsync-over-SSH). Run from cron a few
   minutes after the app's backup interval.
3. **`restore-verify.sh`** (W4): proves a dump actually restores, into a
   throwaway Postgres that never touches your live data. Run on a schedule so a
   silently-corrupt backup is caught early.

All three are complementary. A backup you have never restored is not a backup.

## `offsite-backup.sh`

```bash
# rclone (configure a remote first: `rclone config`)
OFFSITE_METHOD=rclone \
OFFSITE_RCLONE_REMOTE="s3:my-bucket/projecthub" \
  scripts/offsite-backup.sh

# rsync over SSH
OFFSITE_METHOD=rsync \
OFFSITE_RSYNC_DEST="backup@host:/srv/projecthub-backups/" \
OFFSITE_SSH_KEY="$HOME/.ssh/backup_key" \
  scripts/offsite-backup.sh
```

Never deletes local backups (the app owns local retention). Re-running is safe.

Example cron (host), 10 minutes past every 6 hours:

```
10 */6 * * * cd /home/taskhub/taskhub && OFFSITE_METHOD=rclone OFFSITE_RCLONE_REMOTE="s3:bucket/ph" scripts/offsite-backup.sh >> /var/log/ph-offsite.log 2>&1
```

## `restore-verify.sh`

```bash
scripts/restore-verify.sh                 # newest backup in the volume
scripts/restore-verify.sh /path/to.dump   # a specific dump / bundle
```

Exits non-zero on any failure (unreadable archive, failed restore, missing
schema, no applied migrations, core table unqueryable). Wire the exit code into
your monitoring. Requires the `postgres:16` image (already pulled by the stack).

Example cron (host), daily at 03:30:

```
30 3 * * * cd /home/taskhub/taskhub && scripts/restore-verify.sh >> /var/log/ph-restore-verify.log 2>&1 || echo "ProjectHub restore-verify FAILED" | mail -s alert you@example.com
```
