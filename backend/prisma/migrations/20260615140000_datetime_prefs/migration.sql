-- v1.63: per-user timezone, time format, dual-calendar display prefs.
CREATE TYPE "TimeFormat" AS ENUM ('H12', 'H24');

ALTER TABLE "User"
    ADD COLUMN "timeZone" TEXT,
    ADD COLUMN "timeFormat" "TimeFormat" NOT NULL DEFAULT 'H24',
    ADD COLUMN "dualCalendar" BOOLEAN NOT NULL DEFAULT false;
