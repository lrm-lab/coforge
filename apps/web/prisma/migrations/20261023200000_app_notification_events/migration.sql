-- The notification events an app subscribes to, and the ones each installation approved with its
-- data groups. The set is checked against the catalog in features/apps/app-notification-events.ts.
-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "notificationEvents" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "app_installations" ADD COLUMN     "approvedEvents" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "apps" ADD CONSTRAINT "apps_notification_events_check" CHECK (
    "notificationEvents" IS NOT NULL
    AND "notificationEvents" <@ ARRAY['workspace.member_added', 'workspace.member_removed', 'workspace.member_role_changed', 'workspace.config_updated', 'workspace.public_channel_created', 'workspace.public_channel_archived', 'channel.member_added', 'channel.member_removed', 'channel.config_updated', 'channel.archived', 'thread.created', 'agent.status_changed', 'agent.profile_updated', 'agent.runtime_changed', 'agent.model_changed', 'computer.online', 'computer.offline', 'computer.version_changed', 'computer.agent_started', 'computer.agent_stopped']::TEXT[]
);

ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_approved_events_check" CHECK (
    "approvedEvents" IS NOT NULL
    AND "approvedEvents" <@ ARRAY['workspace.member_added', 'workspace.member_removed', 'workspace.member_role_changed', 'workspace.config_updated', 'workspace.public_channel_created', 'workspace.public_channel_archived', 'channel.member_added', 'channel.member_removed', 'channel.config_updated', 'channel.archived', 'thread.created', 'agent.status_changed', 'agent.profile_updated', 'agent.runtime_changed', 'agent.model_changed', 'computer.online', 'computer.offline', 'computer.version_changed', 'computer.agent_started', 'computer.agent_stopped']::TEXT[]
);
