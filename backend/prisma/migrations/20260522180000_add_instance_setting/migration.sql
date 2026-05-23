-- Global instance configuration. Key is the primary key; value is opaque JSON.
-- See InstanceSetting in schema.prisma for the rationale (loose schema, per-key
-- shape enforced by Zod at the route layer).
CREATE TABLE "InstanceSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "InstanceSetting_pkey" PRIMARY KEY ("key")
);
