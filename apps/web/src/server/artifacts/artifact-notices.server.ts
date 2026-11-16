import type { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { errorType } from "#src/server/errors/error-type.server";
import { requireArtifactRead, type ArtifactAccessRow } from "./artifact-access.server";
import { followerIds } from "./artifact-follows.server";
import { lastChangers, versionChanges } from "./artifact-file-authors.server";
import {
  noticeContent,
  type NoticeEvent,
  type NoticeReason,
} from "./artifact-notice-content.server";
import { mentionedIn } from "./artifact-notice-mentions.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";

export type NoticedArtifact = ArtifactAccessRow & { id: string; name: string; title: string };

type Told = { name: string; reason: NoticeReason };
type NotTold = { name: string; reason: "not-agent" | "cannot-see" | "delivery-failed" };

export type NoticeReport = { notified: Told[]; notNotified: NotTold[] };

export const NOBODY_TOLD: NoticeReport = { notified: [], notNotified: [] };

type Db = Pick<
  PrismaClient,
  | "agent"
  | "artifactFollow"
  | "artifactFile"
  | "artifactVersion"
  | "workspaceMembership"
  | "workspace"
  | "conversation"
  | "$queryRaw"
>;

export async function agentCanRead(
  db: Db,
  workspaceId: string,
  agentId: string,
  artifact: ArtifactAccessRow,
): Promise<boolean> {
  try {
    await requireArtifactRead(db, workspaceId, { agentId }, artifact);
    return true;
  } catch (error) {
    if (isAppError(error)) return false;
    throw error;
  }
}

type Audience = { agents: Map<string, NoticeReason>; people: string[] };

export class ArtifactNotices {
  constructor(
    private readonly db: PrismaClient,
    private readonly port: ArtifactNoticePort,
    private readonly canRead: typeof agentCanRead = agentCanRead,
  ) {}

  comment(input: Context & { comment: CommentEvent["comment"] }) {
    return this.guarded(() =>
      this.tell(input, {
        key: input.comment.id,
        texts: [input.comment.body],
        event: (by) => ({ kind: "comment", by, comment: input.comment }),
        followers: "subscribed",
      }),
    );
  }

  review(input: Context & { reviewId: string } & Pick<ReviewEvent, "review" | "comments">) {
    return this.guarded(() =>
      this.tell(input, {
        key: input.reviewId,
        texts: [input.review.body ?? "", ...input.comments.map((comment) => comment.body)],
        event: (by) => ({ kind: "review", by, review: input.review, comments: input.comments }),
        followers: "subscribed",
      }),
    );
  }

  resolve(
    input: Context & {
      threadId: string;
      resolvedAt: Date;
      threadPath: string | null;
      threadAuthorAgentId: string | null;
      note: string | undefined;
    },
  ) {
    const own =
      input.threadAuthorAgentId === null
        ? []
        : [[input.threadAuthorAgentId, "your_comment_resolved"] as const];
    return this.guarded(() =>
      this.tell(input, {
        key: `resolve:${input.threadId}:${input.resolvedAt.getTime()}`,
        texts: input.note ? [input.note] : [],
        event: (by) => ({
          kind: "resolve",
          by,
          thread: { id: input.threadId, path: input.threadPath },
          note: input.note,
        }),
        own,
        followers: input.note ? "subscribed" : undefined,
      }),
    );
  }

  version(input: Context & { number: number; note: string }) {
    return this.guarded(() => this.versionNotice(input));
  }

  private async guarded(work: () => Promise<NoticeReport>): Promise<NoticeReport> {
    try {
      return await work();
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "artifacts:notices_failed", error_type: errorType(error) }),
      );
      return NOBODY_TOLD;
    }
  }

  private async versionNotice(input: Context & { number: number; note: string }) {
    const { artifact, writerId } = input;
    const { changedPaths, renamed } = await versionChanges(this.db, artifact.id, input.number);
    if (changedPaths.length === 0 && !renamed) return NOBODY_TOLD;
    const owners = await lastChangers(this.db, artifact.id, input.number - 1, changedPaths);
    const yourFiles = new Map<string, string[]>();
    for (const [path, agentId] of owners)
      yourFiles.set(agentId, [...(yourFiles.get(agentId) ?? []), path].sort());
    const following = new Set(await followerIds(this.db, artifact.id));
    const own = [...yourFiles.keys()]
      .filter((agentId) => agentId !== writerId && following.has(agentId))
      .map((agentId) => [agentId, "your_file_changed"] as const);
    return this.tell(input, {
      key: `version:${input.number}`,
      texts: [],
      event: (by, agentId) => ({
        kind: "version",
        by,
        number: input.number,
        note: input.note,
        yourFiles: yourFiles.get(agentId) ?? [],
        renamed,
      }),
      own,
      followers: renamed ? "subscribed" : undefined,
    });
  }

  private async audience(input: Context, plan: Plan): Promise<Audience> {
    const { artifact, writerId } = input;
    const [mentions, followers] = await Promise.all([
      mentionedIn(this.db, input.workspaceId, plan.texts),
      plan.followers === undefined ? [] : followerIds(this.db, artifact.id),
    ]);
    const agents = new Map<string, NoticeReason>();
    if (plan.followers) for (const agentId of followers) agents.set(agentId, plan.followers);
    for (const [agentId, reason] of plan.own ?? []) agents.set(agentId, reason);
    for (const agent of mentions.agents) agents.set(agent.id, "mentioned");
    agents.delete(writerId);
    return { agents, people: mentions.people };
  }

  private async tell(input: Context, plan: Plan): Promise<NoticeReport> {
    const { artifact, workspaceId } = input;
    const { agents, people } = await this.audience(input, plan);
    const writer = await this.db.agent.findUniqueOrThrow({
      where: { id: input.writerId },
      select: { name: true },
    });
    const named = await this.db.agent.findMany({
      where: { id: { in: [...agents.keys()] }, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { id: true, name: true },
    });
    const outcomes = await Promise.all(
      named.map(async ({ id, name }): Promise<[Told | undefined, NotTold | undefined]> => {
        const reason = agents.get(id)!;
        if (!(await this.canRead(this.db, workspaceId, id, artifact)))
          return [undefined, { name, reason: "cannot-see" }];
        try {
          await this.port.deliver({
            workspaceId,
            agentId: id,
            key: `${artifact.id}:${plan.key}`,
            content: noticeContent(artifact, reason, plan.event(writer.name, id)),
          });
          return [{ name, reason }, undefined];
        } catch (error) {
          console.warn(
            JSON.stringify({ event: "artifacts:notice_failed", error_type: errorType(error) }),
          );
          return [undefined, { name, reason: "delivery-failed" }];
        }
      }),
    );
    return {
      notified: outcomes.flatMap(([told]) => (told ? [told] : [])),
      notNotified: [
        ...outcomes.flatMap(([, not]) => (not ? [not] : [])),
        ...people.map((name) => ({ name, reason: "not-agent" as const })),
      ],
    };
  }
}

type CommentEvent = Extract<NoticeEvent, { kind: "comment" }>;
type ReviewEvent = Extract<NoticeEvent, { kind: "review" }>;

type Context = {
  workspaceId: string;
  artifact: NoticedArtifact;
  writerId: string;
};

type Plan = {
  key: string;
  texts: readonly string[];
  event: (by: string, agentId: string) => NoticeEvent;
  own?: readonly (readonly [string, NoticeReason])[];
  followers?: NoticeReason | undefined;
};
