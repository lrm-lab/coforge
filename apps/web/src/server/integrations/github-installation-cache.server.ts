import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { installationsSchema } from "./github-account-shapes.server";
import type { GitHubApi } from "./github-api.server";

type ApiInstallation = {
  id: number;
  login: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
  configureUrl: string;
};

export class GitHubInstallationCache {
  constructor(
    private readonly db: PrismaClient,
    private readonly github: GitHubApi,
    private readonly config: { appId: number; installUrl: string },
    private readonly now: () => number,
  ) {}

  private async page(token: string, page: number) {
    const data = installationsSchema.parse(
      await this.github.api(`/user/installations?per_page=30&page=${page}`, token),
    );
    if (data.installations.some((item) => item.app_id !== this.config.appId))
      throw new AppError("ACCESS_DENIED");
    return {
      installations: data.installations.map((item): ApiInstallation => ({
        id: item.id,
        login: item.account.login,
        repositorySelection: item.repository_selection,
        suspended: Boolean(item.suspended_at),
        configureUrl: item.html_url ?? this.config.installUrl,
      })),
      hasMore: page * 30 < data.total_count,
    };
  }

  async fetchAll(token: string) {
    let result = await this.page(token, 1);
    const all = [...result.installations];
    let page = 2;
    while (result.hasMore && page <= 10000) {
      result = await this.page(token, page++);
      all.push(...result.installations);
    }
    return all;
  }

  async replace(userId: string, installations: ApiInstallation[]) {
    const syncedAt = new Date(this.now());
    const byId = new Map<number, ApiInstallation>();
    for (const item of installations) byId.set(item.id, item);
    const unique = [...byId.values()].sort((a, b) => a.id - b.id);
    const keepIds = unique.map((item) => item.id);
    await this.db.$transaction(async (tx) => {
      await tx.gitHubUserInstallation.deleteMany({
        where: { userId, installationId: { notIn: keepIds } },
      });
      if (unique.length === 0) return;
      if (unique.length === 1) {
        const item = unique[0]!;
        const data = {
          accountLogin: item.login,
          repositorySelection: item.repositorySelection,
          suspended: item.suspended,
          configureUrl: item.configureUrl,
          syncedAt,
        };
        await tx.gitHubUserInstallation.upsert({
          where: { userId_installationId: { userId, installationId: item.id } },
          create: { userId, installationId: item.id, ...data },
          update: data,
        });
        return;
      }
      await tx.$executeRaw`INSERT INTO "github_user_installations"
        ("userId", "installationId", "accountLogin", "repositorySelection", "suspended", "configureUrl", "syncedAt")
        SELECT ${userId}::uuid, v."installationId", v."accountLogin", v."repositorySelection", v."suspended", v."configureUrl", ${syncedAt}::timestamp(3)
        FROM unnest(
          ${unique.map((item) => item.id)}::int[],
          ${unique.map((item) => item.login)}::text[],
          ${unique.map((item) => item.repositorySelection)}::text[],
          ${unique.map((item) => item.suspended)}::boolean[],
          ${unique.map((item) => item.configureUrl)}::text[]
        ) AS v("installationId", "accountLogin", "repositorySelection", "suspended", "configureUrl")
        ON CONFLICT ("userId", "installationId") DO UPDATE SET
          "accountLogin" = EXCLUDED."accountLogin",
          "repositorySelection" = EXCLUDED."repositorySelection",
          "suspended" = EXCLUDED."suspended",
          "configureUrl" = EXCLUDED."configureUrl",
          "syncedAt" = EXCLUDED."syncedAt"`;
    });
  }
}
