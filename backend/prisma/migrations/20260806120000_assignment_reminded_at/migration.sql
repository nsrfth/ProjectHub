-- v-next (P3): one-shot marker for the T-1 SLA reminder on assignment requests.
ALTER TABLE "TaskAssignmentRequest" ADD COLUMN "remindedAt" TIMESTAMP(3);
