-- v1.10: per-user display calendar (SHAMSI default — pre-v1.10 behaviour).
CREATE TYPE "CalendarPreference" AS ENUM ('SHAMSI', 'GREGORIAN');

ALTER TABLE "User"
    ADD COLUMN "calendarPreference" "CalendarPreference" NOT NULL DEFAULT 'SHAMSI';
