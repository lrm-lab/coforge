import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { errorType } from "#src/server/errors/error-type.server";
import {
  agentsReadingArtifact,
  peopleReadingArtifact,
  type ArtifactAccessRow,
} from "./artifact-access.server";
import { followerIds } from "./artifact-follows.server";
import { lastChangers, versionChanges } from "./artifact-file-authors.server";
import {
  noticeContent,
  type NoticeEvent,
  type NoticeReason,
} from "./artifact-notice-content.server";
import { mentionedIn, type MentionedAgent } from "./artifact-notice-mentions.server";
import type { ArtifactNoticePort } from "./artifact-notice-port.server";

export type NoticedArtifact = ArtifactAccessRow & { id: string; name: string; title: string };

type Told = { name: string; reason: NoticeReason };
type NotTold = { name: string; reason: "not-agent" | "cannot-see" | "delivery-failed" };

export type NoticeReport = { notified: Told[]; notNotified: NotTold[] };

export const NOBODY_TOLD: NoticeReport = { notified: [], notNotified: [] };

const DELIVERIES_AT_ONCE = 4;

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size)
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  return results;
}

type Audience = {
  agents: Map<string, NoticeReason>;
  people: string[];
  mentioned: { agents: MentionedAgent[]; people: { id: string; username: string }[] };
};

export type MentionCheck = { count: number; cannotSee: string[] };

export type Recipients = Awaited<ReturnType<ArtifactNotices["recipients"]>>;

export class ArtifactNotices {
  constructor(
    private readonly db: PrismaClient,
    private readonly port: ArtifactNoticePort,
    private readonly readers: typeof agentsReadingArtifact = agentsReadingArtifact,
  ) {}

  comment(
    input: (Context | PersonContext) & { comment: CommentEvent["comment"] },
    resolved?: Recipients,
  ) {
    return this.guarded(() =>
      this.tell(
        input,
        {
          ...commentAudience(input.comment.body),
          key: input.comment.id,
          event: (by) => ({ kind: "comment", by, comment: input.comment }),
        },
        resolved,
      ),
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
    input: (Context | PersonContext) & {
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

  rename(input: (Context | PersonContext) & { from: string; to: string; key: string }) {
    return this.guarded(() =>
      this.tell(input, {
        key: `rename:${input.key}`,
        texts: [],
        event: (by) => ({ kind: "rename", by, from: input.from, to: input.to }),
        followers: "subscribed",
      }),
    );
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

  private async audience(input: Reach, plan: AudiencePlan): Promise<Audience> {
    const { artifact } = input;
    const [mentions, followers] = await Promise.all([
      mentionedIn(this.db, input.workspaceId, plan.texts, plan.handlesMax),
      plan.followers === undefined ? [] : followerIds(this.db, artifact.id),
    ]);
    const agents = new Map<string, NoticeReason>();
    if (plan.followers) for (const agentId of followers) agents.set(agentId, plan.followers);
    for (const [agentId, reason] of plan.own ?? []) agents.set(agentId, reason);
    for (const agent of mentions.agents) agents.set(agent.id, "mentioned");
    if (input.writerId !== undefined) agents.delete(input.writerId);
    return {
      agents,
      people: mentions.people.map(({ username }) => username),
      mentioned: mentions,
    };
  }

  async recipients(input: Reach, plan: AudiencePlan) {
    const { artifact, workspaceId } = input;
    const { agents, people, mentioned } = await this.audience(input, plan);
    const named = await this.db.agent.findMany({
      where: { id: { in: [...agents.keys()] }, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { id: true, name: true, displayName: true },
    });
    const [readers, peopleReading] = await Promise.all([
      this.readers(this.db, workspaceId, artifact, [
        ...new Set([...named.map(({ id }) => id), ...mentioned.agents.map(({ id }) => id)]),
      ]),
      peopleReadingArtifact(
        this.db,
        workspaceId,
        artifact,
        mentioned.people.map(({ id }) => id),
      ),
    ]);
    const told = named.flatMap(({ id, name, displayName }) =>
      readers.has(id) ? [{ id, name, label: displayName || name, reason: agents.get(id)! }] : [],
    );
    const notTold = [
      ...named.flatMap(({ id, name }) =>
        readers.has(id) ? [] : [{ name, reason: "cannot-see" as const }],
      ),
      ...people.map((name) => ({ name, reason: "not-agent" as const })),
    ];
    const mentions: MentionCheck = {
      count: mentioned.agents.length + mentioned.people.length,
      cannotSee: [
        ...mentioned.agents.filter(({ id }) => !readers.has(id)).map(({ name }) => name),
        ...mentioned.people
          .filter(({ id }) => !peopleReading.has(id))
          .map(({ username }) => username),
      ],
    };
    return { told, notTold, mentions };
  }

  private async tell(
    input: Context | PersonContext,
    plan: Plan,
    resolved?: Recipients,
  ): Promise<NoticeReport> {
    const { artifact, workspaceId } = input;
    const { told, notTold } = resolved ?? (await this.recipients(input, plan));
    const writer =
      "writerId" in input
        ? await this.db.agent.findUniqueOrThrow({
            where: { id: input.writerId },
            select: { name: true },
          })
        : { name: input.writerName };
    const outcomes = await inBatches(told, DELIVERIES_AT_ONCE, async ({ id, name, reason }) => {
      try {
        await this.port.deliver({
          workspaceId,
          agentId: id,
          key: `${artifact.id}:${plan.key}`,
          content: noticeContent(artifact, reason, plan.event(writer.name, id)),
        });
        return [{ name, reason }, undefined] as const;
      } catch (error) {
        console.warn(
          JSON.stringify({ event: "artifacts:notice_failed", error_type: errorType(error) }),
        );
        return [undefined, { name, reason: "delivery-failed" as const }] as const;
      }
    });
    return {
      notified: outcomes.flatMap(([done]) => (done ? [done] : [])),
      notNotified: [...outcomes.flatMap(([, not]) => (not ? [not] : [])), ...notTold],
    };
  }
}

export const commentAudience = (body: string, handlesMax?: number): AudiencePlan => ({
  texts: [body],
  followers: "subscribed",
  ...(handlesMax === undefined ? {} : { handlesMax }),
});

type CommentEvent = Extract<NoticeEvent, { kind: "comment" }>;
type ReviewEvent = Extract<NoticeEvent, { kind: "review" }>;

type Context = {
  workspaceId: string;
  artifact: NoticedArtifact;
  writerId: string;
};

type Reach = { workspaceId: string; artifact: NoticedArtifact; writerId?: string | undefined };

type PersonContext = {
  workspaceId: string;
  artifact: NoticedArtifact;
  writerName: string;
};

type AudiencePlan = {
  texts: readonly string[];
  own?: readonly (readonly [string, NoticeReason])[];
  followers?: NoticeReason | undefined;
  handlesMax?: number;
};

type Plan = AudiencePlan & {
  key: string;
  event: (by: string, agentId: string) => NoticeEvent;
};
