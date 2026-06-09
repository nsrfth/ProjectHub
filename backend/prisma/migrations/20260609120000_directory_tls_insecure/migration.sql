-- Allow LDAP directories to skip TLS certificate verification (internal AD CAs).
ALTER TABLE "Directory" ADD COLUMN "tlsInsecure" BOOLEAN NOT NULL DEFAULT false;
