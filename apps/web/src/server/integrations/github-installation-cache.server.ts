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

/** The User's App installations: read from GitHub with a user token and cached per User. */
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
    const keepIds = installations.map((item) => item.id);
    await this.db.$transaction(async (tx) => {
      await tx.gitHubUserInstallation.deleteMany({
        where: { userId, installationId: { notIn: keepIds } },
      });
      for (const item of installations) {
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
      }
    });
  }
}
