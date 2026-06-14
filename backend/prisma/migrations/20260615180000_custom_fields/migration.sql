-- v1.58: team-scoped custom field definitions + typed per-task values.

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT', 'CHECKBOX', 'PERSON');

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldOption" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomFieldOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldValue" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "valueText" TEXT,
    "valueNumber" DECIMAL(18,4),
    "valueDate" TIMESTAMP(3),
    "valueBool" BOOLEAN,
    "valueUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldValueOption" (
    "valueId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,

    CONSTRAINT "CustomFieldValueOption_pkey" PRIMARY KEY ("valueId","optionId")
);

-- CreateIndex
CREATE INDEX "CustomFieldDefinition_teamId_active_idx" ON "CustomFieldDefinition"("teamId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_teamId_name_key" ON "CustomFieldDefinition"("teamId", "name");

-- CreateIndex
CREATE INDEX "CustomFieldOption_fieldId_idx" ON "CustomFieldOption"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldOption_fieldId_label_key" ON "CustomFieldOption"("fieldId", "label");

-- CreateIndex
CREATE INDEX "CustomFieldValue_taskId_idx" ON "CustomFieldValue"("taskId");

-- CreateIndex
CREATE INDEX "CustomFieldValue_fieldId_idx" ON "CustomFieldValue"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldValue_fieldId_taskId_key" ON "CustomFieldValue"("fieldId", "taskId");

-- CreateIndex
CREATE INDEX "CustomFieldValueOption_optionId_idx" ON "CustomFieldValueOption"("optionId");

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldOption" ADD CONSTRAINT "CustomFieldOption_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomFieldDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomFieldDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_valueUserId_fkey" FOREIGN KEY ("valueUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValueOption" ADD CONSTRAINT "CustomFieldValueOption_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "CustomFieldValue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValueOption" ADD CONSTRAINT "CustomFieldValueOption_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "CustomFieldOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grant customfield.manage to every existing system Manager role.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'customfield.manage'
FROM "Role" r
WHERE r."isSystem" = true AND r."name" = 'Manager'
ON CONFLICT DO NOTHING;
