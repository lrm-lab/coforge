import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  GrantStore,
  GrantSubject,
  RedeemableCode,
  RedeemedCode,
} from "#src/server/authorization-server/grants.server";
import { publicAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

/** What a code granted, in every read of it. */
const CODE_GRANT = {
  id: true,
  appId: true,
  userId: true,
  workspaceId: true,
  scopes: true,
  authTime: true,
  nonce: true,
} as const;

/** The token and UserInfo endpoints' rows: apps as authenticated clients, authorization codes
 * redeemed once, and the person, app and Workspace a code names as they are now. What a request
 * may do stays in `server/authorization-server/`. */
export class PrismaGrantStore implements GrantStore {
  constructor(private readonly db: PrismaClient) {}

  async findClient(key: string) {
    const app = await this.db.app.findUnique({
      where: { key },
      select: { id: true, clientSecretHash: true },
    });
    return app ?? undefined;
  }

  async findCode(codeHash: string): Promise<RedeemableCode | undefined> {
    const row = await this.db.oAuthAuthorizationCode.findUnique({
      where: { codeHash },
      select: {
        ...CODE_GRANT,
        redirectUri: true,
        codeChallenge: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
    return row ? withoutNullNonce(row) : undefined;
  }

  /** One conditional update, so of two concurrent redemptions exactly one sees its row change. */
  async redeemCode(id: string, at: Date) {
    const { count } = await this.db.oAuthAuthorizationCode.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: at },
    });
    return count === 1;
  }

  /** Keeps the first time a replay was seen. */
  async markCodeReplayed(id: string, at: Date) {
    await this.db.oAuthAuthorizationCode.updateMany({
      where: { id, replayedAt: null },
      data: { replayedAt: at },
    });
  }

  async findRedeemedCode(id: string): Promise<RedeemedCode | undefined> {
    const row = await this.db.oAuthAuthorizationCode.findFirst({
      where: { id, consumedAt: { not: null } },
      select: { ...CODE_GRANT, replayedAt: true },
    });
    if (!row) return undefined;
    const { replayedAt, ...code } = row;
    return { ...withoutNullNonce(code), replayed: replayedAt !== null };
  }

  /** The person, the app, the person's membership and consent and the app's installation, read
   * together. */
  async findGrantSubject({
    userId,
    appId,
    workspaceId,
  }: {
    userId: string;
    appId: string;
    workspaceId: string;
  }): Promise<GrantSubject | undefined> {
    const [user, app, workspace, membership, installation, consent] = await Promise.all([
      this.db.user.findUnique({
        where: { id: userId },
        select: { username: true, displayName: true, email: true, avatarObjectKey: true },
      }),
      this.db.app.findUnique({ where: { id: appId }, select: { key: true, allowedScopes: true } }),
      this.db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
      this.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { role: true },
      }),
      this.db.appInstallation.findUnique({
        where: { appId_workspaceId: { appId, workspaceId } },
        select: { id: true },
      }),
      this.db.userAppConsent.findUnique({
        where: { userId_appId_workspaceId: { userId, appId, workspaceId } },
        select: { scopes: true, revokedAt: true },
      }),
    ]);
    if (!user || !app || !workspace) return undefined;
    return {
      clientId: app.key,
      appScopes: app.allowedScopes,
      ...(consent && consent.revokedAt === null ? { consentScopes: consent.scopes } : {}),
      installed: installation !== null,
      ...(membership ? { role: membership.role } : {}),
      person: {
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        picture: publicAvatarUrl(userId, user.avatarObjectKey),
      },
      workspace: { id: workspaceId, slug: workspace.slug },
    };
  }
}

function withoutNullNonce<Row extends { nonce: string | null }>(
  row: Row,
): Omit<Row, "nonce"> & { nonce?: string } {
  const { nonce, ...rest } = row;
  return nonce === null ? rest : { ...rest, nonce };
}
