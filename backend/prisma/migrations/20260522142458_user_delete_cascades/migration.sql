-- Make Project.ownerId nullable, change FK to SetNull
ALTER TABLE "Project" DROP CONSTRAINT "Project_ownerId_fkey";
ALTER TABLE "Project" ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Make Task.creatorId nullable, change FK to SetNull
ALTER TABLE "Task" DROP CONSTRAINT "Task_creatorId_fkey";
ALTER TABLE "Task" ALTER COLUMN "creatorId" DROP NOT NULL;
ALTER TABLE "Task" ADD CONSTRAINT "Task_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Task.assigneeId was already nullable; change FK from NoAction to SetNull
ALTER TABLE "Task" DROP CONSTRAINT "Task_assigneeId_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Make Comment.authorId nullable, change FK to SetNull
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_authorId_fkey";
ALTER TABLE "Comment" ALTER COLUMN "authorId" DROP NOT NULL;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Activity rows cascade-delete with their actor (observability, not audit)
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_actorId_fkey";
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Attachments cascade-delete with their uploader (orphan files on disk
-- need a separate GC; the DB row goes away with the user account)
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_uploaderId_fkey";
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;