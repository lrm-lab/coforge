-- Where an app's Agent manifest is: an https URL the publisher gives, or null for none.
ALTER TABLE "apps" ADD COLUMN     "agentManifestUrl" TEXT;

ALTER TABLE "apps" ADD CONSTRAINT "apps_agent_manifest_url_check" CHECK (
    "agentManifestUrl" IS NULL
    OR (
        char_length("agentManifestUrl") <= 2000
        AND position('#' IN "agentManifestUrl") = 0
        AND "agentManifestUrl" LIKE 'https://%'
    )
);
