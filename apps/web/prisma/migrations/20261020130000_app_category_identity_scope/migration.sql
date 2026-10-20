-- An app's category, one of nine, `other` for the apps registered before it. Agent tokens take
-- the app's key (its client_id) as their audience, so the resource URI goes.
ALTER TABLE "apps" DROP COLUMN "resourceUri",
ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'other';

ALTER TABLE "apps" ADD CONSTRAINT "apps_category_check" CHECK (
    "category" IN (
        'ai-automation',
        'communication',
        'productivity',
        'developer-tools',
        'data-analytics',
        'business-ops',
        'infrastructure',
        'content-creative',
        'other'
    )
);

-- Every app now has openid, profile and identity (which replaces workspace), and keeps email
-- when it had it.
UPDATE "apps"
SET "allowedScopes" = ARRAY['openid', 'profile', 'identity']::TEXT[]
    || CASE WHEN 'email' = ANY ("allowedScopes") THEN ARRAY['email']::TEXT[] ELSE ARRAY[]::TEXT[] END;
