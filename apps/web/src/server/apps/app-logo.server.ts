import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  publicImageUrlOrFallback,
  versionedImagePath,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";

/**
 * Where the browser reads an app's logo: the image CDN when this deployment has one, at the icon
 * size, so anyone shown the app (the consent page, later people of other Workspaces) can load it;
 * otherwise the app's own route, which serves people of a Workspace where it is installed,
 * versioned by the object. `null` without a logo: the surface shows the monogram. A private share
 * page (`shareToken`) reads it through the token's own route instead, which checks the link on
 * every read, because the person opening it has not installed the app yet.
 */
export function appLogoUrl(
  ownerWorkspaceId: string,
  appKey: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
  shareToken?: string,
): string | null {
  return publicImageUrlOrFallback(
    objectKey,
    PROFILE_IMAGE_STYLES.icon,
    (key) =>
      shareToken === undefined
        ? versionedImagePath(`/api/workspaces/${ownerWorkspaceId}/apps/${appKey}/logo`, key)
        : `/api/apps/share/${encodeURIComponent(shareToken)}/logo`,
    publicUrl,
  );
}

/** A new logo's object, under its Workspace's prefix like the Workspace's other images; deleting
 * the Workspace removes it among the image keys its rows name (`WorkspaceDeletion`). */
export function appLogoObjectKey(ownerWorkspaceId: string, appKey: string): string {
  return `workspaces/${ownerWorkspaceId}/apps/${appKey}/logos/${crypto.randomUUID()}/original`;
}

/**
 * The face an app's bot shows: its app's logo wherever a surface would otherwise draw the
 * mascot the bot's id chooses. Null without a logo — the surface's monogram stands
 * in, as every app surface does; the mascot never does.
 */
export function appBotAvatarUrl(
  bot:
    | {
        installation?: {
          app: { key: string; ownerWorkspaceId: string; logoObjectKey: string | null };
        };
        appBot?: {
          installation: {
            app: { key: string; ownerWorkspaceId: string; logoObjectKey: string | null };
          };
        } | null;
      }
    | null
    | undefined,
): string | null {
  const app = bot?.installation?.app ?? bot?.appBot?.installation.app;
  return app ? appLogoUrl(app.ownerWorkspaceId, app.key, app.logoObjectKey) : null;
}

/** The `appBot` select every read that draws an app bot's face shares: through the bot's
 * installation to the app that owns the logo. Spread it into the agent select, and read the
 * face with `appBotAvatarUrl(bot) ?? mascot`. */
export const APP_BOT_LOGO_SELECT = {
  select: {
    installation: {
      select: { app: { select: { key: true, ownerWorkspaceId: true, logoObjectKey: true } } },
    },
  },
} as const;

/** The app behind a bot row selected with `APP_BOT_LOGO_SELECT`. */
export type AppBotLogoRow = {
  appBot: {
    installation: { app: { key: string; ownerWorkspaceId: string; logoObjectKey: string | null } };
  } | null;
};

/**
 * The face an Agent shows on the server: an app's bot wears its app's logo, any other Agent the
 * mascot its mascot key (or id) chooses. Reads pick a face with this and select
 * `APP_BOT_LOGO_SELECT` beside `avatarMascot`, so every surface draws the same face (ui's rule:
 * one identity, one picture).
 */
export function agentFaceUrl(agent: {
  id: string;
  avatarMascot?: string | null;
  appBot?: {
    installation: { app: { key: string; ownerWorkspaceId: string; logoObjectKey: string | null } };
  } | null;
}): string {
  const app = agent.appBot?.installation.app;
  const logo = app ? appLogoUrl(app.ownerWorkspaceId, app.key, app.logoObjectKey) : null;
  return logo ?? agentAvatarUrl(agent.id, agent.avatarMascot);
}
