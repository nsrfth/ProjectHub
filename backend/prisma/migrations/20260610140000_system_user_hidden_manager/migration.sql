-- v1.49: hidden system manager on all teams
ALTER TABLE "User" ADD COLUMN "isSystemUser" BOOLEAN NOT NULL DEFAULT false;

UPDATE "User"
SET "isSystemUser" = true
WHERE LOWER("email") = 'admin@taskhub.local';
