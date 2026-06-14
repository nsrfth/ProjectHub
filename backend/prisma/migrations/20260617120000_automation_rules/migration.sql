-- v1.60: automation rules (triggers, conditions, actions, run log).

CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL,
    "conditionMatch" TEXT NOT NULL DEFAULT 'ALL',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationCondition" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "factType" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "valueJson" JSONB,
    "customFieldId" TEXT,

    CONSTRAINT "AutomationCondition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationAction" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "valueJson" JSONB,
    "customFieldId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AutomationAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutomationRule_teamId_enabled_triggerType_idx" ON "AutomationRule"("teamId", "enabled", "triggerType");
CREATE INDEX "AutomationCondition_ruleId_idx" ON "AutomationCondition"("ruleId");
CREATE INDEX "AutomationAction_ruleId_idx" ON "AutomationAction"("ruleId");
CREATE INDEX "AutomationRun_ruleId_createdAt_idx" ON "AutomationRun"("ruleId", "createdAt");
CREATE INDEX "AutomationRun_taskId_idx" ON "AutomationRun"("taskId");

ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationCondition" ADD CONSTRAINT "AutomationCondition_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationAction" ADD CONSTRAINT "AutomationAction_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant automation.manage to every existing system Manager role.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'automation.manage'
FROM "Role" r
WHERE r."isSystem" = true AND r."name" = 'Manager'
ON CONFLICT DO NOTHING;
