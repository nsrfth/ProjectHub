-- v1.13: per-user theme + language preference. LIGHT + EN defaults match
-- pre-v1.13 behaviour for every existing user.
CREATE TYPE "ThemePreference" AS ENUM ('LIGHT', 'DARK');
CREATE TYPE "LanguagePreference" AS ENUM ('EN', 'FA');

ALTER TABLE "User"
    ADD COLUMN "themePreference" "ThemePreference" NOT NULL DEFAULT 'LIGHT',
    ADD COLUMN "languagePreference" "LanguagePreference" NOT NULL DEFAULT 'EN';
