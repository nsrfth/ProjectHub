-- v1.69: intake forms — team-scoped task intake with optional public submission.

CREATE TABLE "IntakeForm" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'TEAM',
    "publicToken" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeForm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntakeFormField" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "customFieldId" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "helpText" TEXT,
    "position" INT NOT NULL,

    CONSTRAINT "IntakeFormField_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntakeForm_publicToken_key" ON "IntakeForm"("publicToken");
CREATE INDEX "IntakeForm_teamId_idx" ON "IntakeForm"("teamId");
CREATE INDEX "IntakeFormField_formId_idx" ON "IntakeFormField"("formId");

ALTER TABLE "IntakeForm" ADD CONSTRAINT "IntakeForm_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntakeForm" ADD CONSTRAINT "IntakeForm_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntakeForm" ADD CONSTRAINT "IntakeForm_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntakeFormField" ADD CONSTRAINT "IntakeFormField_formId_fkey" FOREIGN KEY ("formId") REFERENCES "IntakeForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntakeFormField" ADD CONSTRAINT "IntakeFormField_customFieldId_fkey" FOREIGN KEY ("customFieldId") REFERENCES "CustomFieldDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Grant form.manage to every existing system Manager role.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'form.manage'
FROM "Role" r
WHERE r."isSystem" = true AND r."name" = 'Manager'
ON CONFLICT DO NOTHING;
