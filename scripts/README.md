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

## Kopia + Google Drive (recommended offsite: encrypted, versioned, with a UI)

For an UpdraftPlus-style experience — a web dashboard, snapshot history,
one-click restore, retention, and client-side encryption — use the **Kopia**
service (compose `backup` profile) instead of `offsite-backup.sh`. It snapshots
the app's dumps (`backups_data`) and stores them **encrypted** on Google Drive.

Kopia encrypts every object with `KOPIA_PASSWORD` *before* upload, so Google
only sees ciphertext — which matters because a ProjectHub dump bundle contains
`secrets.env`. **If you lose `KOPIA_PASSWORD`, the backups are unrecoverable.**

### One-time setup

1. **Enable the on-box dump scheduler** so there's something to back up:
   set `BACKUP_ENABLED=true` in `.env` (and pick period/retention in
   Settings → Backups), then `docker compose up -d --force-recreate backend`.

2. **Create a Google Cloud service account** (unattended — no OAuth to refresh):
   - Google Cloud Console → new/any project → **APIs & Services → Enable APIs →
     enable "Google Drive API"**.
   - **IAM & Admin → Service Accounts → Create** → create a **JSON key** and
     download it.
   - Save that JSON at **`secrets/kopia-gdrive-sa.json`** in the compose dir
     (git-ignored).
   - In **Google Drive**, create a folder (e.g. `projecthub-kopia`), **Share**
     it with the service account's email (`…@….iam.gserviceaccount.com`,
     *Editor*), and copy the **folder id** from its URL
     (`drive.google.com/drive/folders/<THIS>`).

3. **Fill `.env`**: `KOPIA_PASSWORD` (long random), `KOPIA_SERVER_USERNAME`,
   `KOPIA_SERVER_PASSWORD`, `KOPIA_GDRIVE_FOLDER_ID`.

4. **Initialise the repository + policy + first snapshot**:
   ```bash
   scripts/kopia-setup.sh
   ```

5. **Start the UI**:
   ```bash
   docker compose --profile backup up -d kopia
   ```
   Open `http://<host>:51515`, log in with the `KOPIA_SERVER_*` creds. From
   there you can browse snapshots, trigger a backup, and **restore** files.

Snapshots then run on the schedule set by `kopia-setup.sh` (every 6h) while the
service is up, with retention `keep-daily 7 / weekly 4 / monthly 6 / annual 1`.

### Restoring
Use the web UI (snapshot → *Restore*), or from the CLI:
```bash
docker compose --profile backup run --rm kopia snapshot list /app/backups
docker compose --profile backup run --rm kopia restore <snapshot-id> /app/backups/restored
```
Then feed the recovered `*.tar.gz` to `restore-verify.sh` (below) or the
admin Settings → Backups → Restore flow.

### Notes
- Trusted-LAN HTTP: the UI runs with `--insecure`. For HTTPS, drop `--insecure`
  in the compose service and add `--tls-generate-cert` (first run), or proxy it
  through Caddy.
- Google Drive's API is rate-limited and best for periodic dumps. Pair it with
  `restore-verify.sh` so you notice if snapshots ever stop. For heavier use an
  S3-compatible bucket (B2/Wasabi/MinIO) is more robust — Kopia supports those
  natively too; only the repository backend in `kopia-setup.sh` changes.

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
