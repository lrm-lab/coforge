import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../apps/web/src/generated/prisma/client";
import { PrismaOpenVikingBindingStore } from "../../../apps/web/src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../../../apps/web/src/server/db/repositories/workspace-memory-profile.repositories.server";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../../../apps/web/src/server/workspace-memory/profile";
import { saveProfileTransition } from "../../../apps/web/src/server/workspace-memory/stores";
import type { EvalArm } from "./types";

export type EvalWorkspace = {
  db: PrismaClient;
  workspaceId: string;
  slug: string;
  channelId: string;
  evalUserId: string;
  memoryAgentId: string;
  taskAgentId: string;
  userIds: string[];
  computerId: string;
  machineId: string;
};

/** The Task Agent's standing role: consume the Memory Agent's cited offer
 * (recalled experience from earlier tasks in this room) and execute the
 * current task in its own workspace, reporting the final answer in the
 * channel. */
export const TASK_AGENT_DESCRIPTION = [
  "You are the Task Agent of this channel's team.",
  "The human member posts task prompts addressed to both you (@task) and @memory. Memory starts retrieval",
  "from that task independently. You may read the original channel prompt",
  "and prepare analysis. Before implementation complete this episode's claim on the human's original",
  "root message and verify it succeeded. If the claim fails, stop implementation and report the blocker.",
  "When you need prior experience OR documents/evidence to solve the task, send a channel message",
  "mentioning @memory with a specific query and the constraints you need verified if its initial retrieval",
  "does not already cover your needs. You may ask again",
  "as new questions arise. Wait for the Memory Agent's reply to that request before using its evidence.",
  "Both document search and experience retrieval belong to Memory Agent: do not call BM25/search",
  "scripts, skills_list, OpenViking directly, or read raw corpus/index/ledger files yourself.",
  "The harness does not retrieve or inject memory before your turn. For a cited Memory Hint addressed",
  "to you, call native memory_disposition with hint_id, decision=adopt|reject|defer, and a reason before",
  "applying it. A channel reply is not a receipt; adopt records intent, not execution. Other tools stay available.",
  "Execute in your own workspace using the shell, starting from the original task prompt.",
  "Post your final answer as your last channel message in the exact format the task requests;",
  "Send no intermediate progress notifications; @memory retrieval requests are allowed and are not",
  "final answers. This evaluation treats your last non-request Task channel message as the final answer.",
  "Verify the final send returns accepted=true and a messageId; the CLI's --json receipt",
  "renders acceptance as state=sent plus messageId. Without a receipt, never claim",
  "the answer was submitted; follow the send's retry/draft instructions and report any blocker honestly.",
].join(" ");

function slugFor(arm: EvalArm, familyId: string): string {
  const safe = familyId.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40);
  return `evol-${arm}-${safe}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}

export function connectEvalDb(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export async function provisionEvalWorkspace(input: {
  db: PrismaClient;
  arm: EvalArm;
  familyId: string;
  benchmark: string;
  ovAccountId: string;
}): Promise<EvalWorkspace> {
  const suffix = crypto.randomUUID();
  const owner = await input.db.user.create({
    data: { username: `sb-eval-${suffix}`, displayName: "user" },
  });
  let createdWorkspaceId: string | undefined;
  let createdComputerId: string | undefined;
  try {
    const workspace = await input.db.workspace.create({
      data: {
        slug: slugFor(input.arm, input.familyId),
        name: `evol collab ${input.arm} ${input.familyId}`,
        members: {
          create: [{ userId: owner.id, role: "owner" }],
        },
      },
    });
    createdWorkspaceId = workspace.id;
    const machineId = crypto.randomUUID();
    const computer = await input.db.computer.create({
      data: { ownerId: owner.id, machineId, name: "sb-eval" },
    });
    createdComputerId = computer.id;
    // Both agents' runtimeConfig is replaced by the eval daemon with the
    // encrypted provider credential at start time.
    const memoryAgent = await input.db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: "memory",
        displayName: "Memory",
        description:
          "The human posts each task to both @task and you (@memory). On that initial mention, read the task, formulate relevant queries, and start retrieval without waiting for a separate Task request. Respond also to subsequent Task @memory requests. Task owns the original task claim and final answer; your role is retrieval and cited support. Retrieve prior experience from viking://resources/evo-ir/experiences and evidence documents from viking://resources/evo-ir/documents when those prepared collections are present. Set targetUri to the relevant collection so unrelated account directory summaries do not displace evidence. Use ov_find with BM25 only and ov_read as needed. Search viking://resources/causal for published Fork/AIG nodes; use retrieval.chainRef, a served node URI and its listed relations with ov_expand to follow multiple hops. You have three retrieval reads per trigger: find plus two expansions fits that budget. Distinguish recorded AIG evidence from counterfactual Fork steps; do not use embedding or ov_search_context; return a cited memory_offer addressed to @task. Do not invent citations or claim retrieval succeeded when tools fail.",
        computerId: null,
        runtimeConfig: {},
      },
    });
    const taskAgent = await input.db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        name: "task",
        displayName: "Task",
        description: TASK_AGENT_DESCRIPTION,
        computerId: null,
        runtimeConfig: {},
      },
    });
    await input.db.workspaceMemoryAgent.create({
      data: { workspaceId: workspace.id, agentId: memoryAgent.id },
    });
    const channel = await input.db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName:
          input.familyId
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .slice(0, 50) || "evol",
        description: `${input.benchmark} group-chat collaboration eval`,
      },
    });
    await input.db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, userId: owner.id },
    });
    for (const agent of [memoryAgent, taskAgent]) {
      await input.db.conversationMember.create({
        data: {
          conversationId: channel.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          channelMuted: agent.id === memoryAgent.id,
        },
      });
    }

    const activationAt = new Date("2026-01-01T00:00:00.000Z");
    const profiles = new PrismaWorkspaceMemoryProfileStore(input.db);
    const seed = createDefaultWorkspaceMemoryProfile(workspace.id);
    // The memory arm is always openviking: warm/cold differ in how much
    // history has been admitted, not in the memory backend.
    const selected = applyWorkspaceMemoryCommand(
      seed,
      { type: "select_desired", desired: "openviking", at: activationAt },
      { prototypeEnabled: true },
    );
    if (!selected.ok) throw new Error(selected.failure.code);
    const ready = applyWorkspaceMemoryCommand(selected.profile, {
      type: "observe_ready",
      generation: selected.profile.generation,
    });
    if (!ready.ok) throw new Error(ready.failure.code);
    if ((await saveProfileTransition(profiles, seed, ready.profile)) !== "saved") {
      throw new Error("profile transition was not saved");
    }

    const bindings = new PrismaOpenVikingBindingStore(input.db);
    if (
      (await bindings.compareAndSet({
        workspaceId: workspace.id,
        expectedGeneration: 0,
        binding: {
          workspaceId: workspace.id,
          accountId: input.ovAccountId,
          serviceIdentityId: `svc-${input.ovAccountId}`,
          credentialRef: `secret:ov-${input.ovAccountId}`,
          generation: ready.profile.generation,
        },
      })) !== "saved"
    ) {
      throw new Error("openviking binding was not saved");
    }

    // OpenViking-only designation (ADR 0062): the Memory Agent route authorizes
    // through a memory_agent mapped identity, mirroring mapMemoryActor().
    await input.db.openVikingMappedIdentity.create({
      data: {
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        actorKind: "memory_agent",
        actorSubject: memoryAgent.id,
        openvikingUserId: `memory-agent:${memoryAgent.id}`,
        role: "user",
        access: "readonly_shared",
        generation: ready.profile.generation,
      },
    });

    return {
      db: input.db,
      workspaceId: workspace.id,
      slug: workspace.slug,
      channelId: channel.id,
      evalUserId: owner.id,
      memoryAgentId: memoryAgent.id,
      taskAgentId: taskAgent.id,
      userIds: [owner.id],
      computerId: computer.id,
      machineId,
    };
  } catch (error) {
    if (createdWorkspaceId) await input.db.workspace.delete({ where: { id: createdWorkspaceId } });
    if (createdComputerId) await input.db.computer.delete({ where: { id: createdComputerId } });
    await input.db.user.delete({ where: { id: owner.id } });
    throw error;
  }
}

export async function resetAgentSessions(workspace: EvalWorkspace): Promise<void> {
  // Only drop the Session association. Writing `runtimeSession: null` becomes JSON null, which
  // makes AgentControl's JSONB CAS (`Prisma.DbNull`) miss on every attempt.
  await workspace.db.agent.update({
    where: { id: workspace.memoryAgentId },
    data: { currentSessionId: null },
  });
  await workspace.db.agent.update({
    where: { id: workspace.taskAgentId },
    data: { currentSessionId: null },
  });
}

export async function destroyEvalWorkspace(workspace: EvalWorkspace): Promise<void> {
  await workspace.db.workspace
    .delete({ where: { id: workspace.workspaceId } })
    .catch(() => undefined);
  await workspace.db.computer
    .delete({ where: { id: workspace.computerId } })
    .catch(() => undefined);
  if (workspace.userIds.length > 0) {
    await workspace.db.user
      .deleteMany({ where: { id: { in: workspace.userIds } } })
      .catch(() => undefined);
  }
}
