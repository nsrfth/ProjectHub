-- v2.5.27: add COMPANY (legal subsidiary) to OrgUnitType (additive, reporting-only).
-- Placement rules (lib/orgUnitTree.ts): COMPANY under HOLDING or COMPANY;
-- PORTFOLIO's allowed parents extended to include COMPANY. Existing rows stay valid.

ALTER TYPE "OrgUnitType" ADD VALUE IF NOT EXISTS 'COMPANY';
