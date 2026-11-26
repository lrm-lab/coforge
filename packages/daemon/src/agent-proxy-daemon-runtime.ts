import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInboxReadItem, AgentInboxReadTargetKind } from "@lrm/coforge-sdk/agent";
import {
  isChannelMessageTarget,
  isChannelTarget,
  isRecord,
  parseRuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { codeAgentProviderCapabilities } from "#src/code-agent/registry";
import type { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { canonicalThreadTarget } from "#src/daemon-runtime/thread-target";
import { AgentAppInboxPersistence } from "#src/persistence/agent-app-inbox-store";
import { isSafePathScope } from "#src/persistence/path-scope";
import type { AgentProxyCollabHooks, AgentProxyRuntime } from "#src/agent-proxy-runtime";
import { attachmentRuntime } from "#src/agent-proxy-attachment-runtime";
import { mentionRuntime } from "#src/agent-proxy-mention-runtime";
import { conversationRuntime } from "#src/agent-proxy-conversation-runtime";
import { appRuntime } from "#src/agent-proxy-app-runtime";
import { workspaceRuntime } from "#src/agent-proxy-workspace-runtime";
import { agentSessionIsLive } from "#src/agent-proxy-session-admission";

const APP_EVENT_TARGET = /^@app\.(?:system\.)?[a-z][a-z0-9-]{2,63}$/;

function classifyReadKind(target: string): AgentInboxReadTargetKind {
  if (APP_EVENT_TARGET.test(target)) return "app_events";
  if (isChannelMessageTarget(target) && !isChannelTarget(target)) return "thread";
  return "conversation";
}

function createCollabHooks(requireRuntime: () => DaemonRuntime): AgentProxyCollabHooks {
  return {
    authorize: (context, key) => requireRuntime().authorizedAgent(context, key),
    stateDirectory: () => requireRuntime().stateDirectory,
    stateDb: (agentId) => requireRuntime().consumedSeqs?.borrowStateDb(agentId),
    reportsCompaction(agentId) {
      const rt = requireRuntime();
      const provider =
        rt.runtime(agentId)?.config.provider ?? rt.restartConfig(agentId)?.config.provider;
      if (!provider) return false;
      const known = parseRuntimeProvider(provider);
      return known ? codeAgentProviderCapabilities(known).reportsCompaction : false;
    },
    canonicalizeTarget: (context, target, agentApiKey) =>
      canonicalThreadTarget(target, async (parent, anchor) => {
        const res = await requireRuntime().agentMessage(
          context,
          {
            idempotencyKey: crypto.randomUUID(),
            context,
            operation: "read",
            target: parent,
            around: anchor,
            limit: 1,
          },
          agentApiKey,
        );
        return {
          accepted: res.accepted,
          messages: res.messages.map((m) => ({ id: m.id, target: m.target || undefined })),
        };
      }),
    async readMessagesForInbox(context, request, agentApiKey) {
      const target = request.target.trim();
      const limit = Math.min(100, Math.max(1, request.limit ?? 20));
      let after = request.cursor;
      let page = await requireRuntime().agentMessage(
        context,
        {
          idempotencyKey: crypto.randomUUID(),
          context,
          operation: "read",
          target,
          unread: true,
          ...(after ? { after } : {}),
          limit,
        },
        agentApiKey,
      );
      for (
        let step = 0;
        step < 3 &&
        page.messages.length === 0 &&
        Boolean(page.moreUnread || page.hasNewer) &&
        page.readPositionAfter !== undefined &&
        String(page.readPositionAfter) !== after;
        step += 1
      ) {
        after = String(page.readPositionAfter);
        page = await requireRuntime().agentMessage(
          context,
          {
            idempotencyKey: crypto.randomUUID(),
            context,
            operation: "read",
            target,
            unread: true,
            after,
            limit,
          },
          agentApiKey,
        );
      }
      const items: AgentInboxReadItem[] = page.messages.map((m) => {
        const rawSender = m.senderHandle || (target.startsWith("@app.") ? target : "system");
        return {
          kind: "message",
          id: m.id,
          seq: m.sequence,
          sender: rawSender === "system" || rawSender.startsWith("@") ? rawSender : `@${rawSender}`,
          createdAt: m.createdAt,
          body: m.body,
        };
      });
      const hasMore = Boolean(page.moreUnread || page.hasNewer);
      const lastSeq =
        page.readPositionAfter ??
        (items.length > 0 && items[items.length - 1]!.kind === "message"
          ? (items[items.length - 1] as Extract<AgentInboxReadItem, { kind: "message" }>).seq
          : undefined);
      return {
        ok: true,
        kind: classifyReadKind(target),
        target,
        items,
        hasMore,
        nextCursor: hasMore && lastSeq !== undefined ? String(lastSeq) : null,
        ...(page.readPositionAfter !== undefined
          ? { readPositionAfter: page.readPositionAfter }
          : {}),
      };
    },
    async settleDismissedTargets(context, targets, agentApiKey, requestedTarget) {
      const rt = requireRuntime();
      const chatTargets = [
        ...new Set(targets.filter((t) => t && t !== "reminders" && !t.startsWith("reminder:"))),
      ];
      const reminderIds = new Set(
        targets
          .filter((t) => t.startsWith("reminder:"))
          .map((t) => t.slice("reminder:".length).trim())
          .filter(Boolean),
      );
      if (requestedTarget?.startsWith("reminder:")) {
        const reqId = requestedTarget.slice("reminder:".length).trim();
        if (reqId) reminderIds.add(reqId);
      }
      const dismissAllReminders = requestedTarget === "reminders";
      await Promise.all(
        chatTargets.map((target) =>
          rt
            .agentMessage(
              context,
              {
                idempotencyKey: crypto.randomUUID(),
                context,
                operation: "read",
                target,
                unread: true,
                limit: 1,
              },
              agentApiKey,
            )
            .catch(() => undefined),
        ),
      );
      if (dismissAllReminders || reminderIds.size > 0) {
        const agentId = rt.authorizedAgent(context, agentApiKey);
        const wsDirs = await readdir(join(rt.stateDirectory, "app-inbox"), {
          withFileTypes: true,
        }).catch(() => []);
        for (const ws of wsDirs) {
          if (!ws.isDirectory() || !isSafePathScope(ws.name)) continue;
          const items = await new AgentAppInboxPersistence(rt.stateDirectory, ws.name, agentId)
            .read()
            .catch(() => null);
          if (!items) continue;
          for (const entry of items) {
            if (
              !isRecord(entry) ||
              entry.appId !== "system.reminder" ||
              !isRecord(entry.sourceRef) ||
              entry.sourceRef.kind !== "reminder" ||
              typeof entry.sourceRef.id !== "string" ||
              typeof entry.sourceRef.revision !== "string"
            )
              continue;
            if (!dismissAllReminders && !reminderIds.has(entry.sourceRef.id)) continue;
            const revision = Number(entry.sourceRef.revision);
            if (!Number.isSafeInteger(revision) || revision < 1) continue;
            await rt
              .reminder(
                context,
                {
                  idempotencyKey: crypto.randomUUID(),
                  context,
                  operation: "dismiss",
                  reminderId: entry.sourceRef.id,
                  revision,
                },
                agentApiKey,
              )
              .catch(() => undefined);
          }
        }
      }
    },
  };
}

export function daemonAgentProxyRuntime(
  requireRuntime: () => DaemonRuntime,
): Required<AgentProxyRuntime> {
  const agentApi = () => requireRuntime().agentRequests;
  const localQueries = () => requireRuntime().localQueries;
  return {
    agentMemory: async (...args) => requireRuntime().agentMemory(...args),
    agentContext: async (...args) => localQueries().context(...args),
    procList: async (...args) => localQueries().procList(...args),
    procStart: async (...args) => localQueries().procStart(...args),
    procLogs: async (...args) => localQueries().procLogs(...args),
    procStop: async (...args) => localQueries().procStop(...args),
    agentMessage: async (...args) => requireRuntime().agentMessage(...args),
    ...attachmentRuntime(agentApi),
    ...mentionRuntime(agentApi),
    ...conversationRuntime(agentApi),
    inbox: async (...args) => requireRuntime().inbox(...args),
    reminder: async (...args) => requireRuntime().reminder(...args),
    agentTask: async (...args) => requireRuntime().agentTask(...args),
    agentChannel: async (...args) => agentApi().agentChannel(...args),
    agentActionPrepare: async (...args) => agentApi().agentActionPrepare(...args),
    agentWeeklyReport: async (...args) => agentApi().agentWeeklyReport(...args),
    agentWeeklyReportCollect: async (...args) => agentApi().agentWeeklyReportCollect(...args),
    agentWeeklyReportKeyPoints: async (...args) => agentApi().agentWeeklyReportKeyPoints(...args),
    agentWeeklyReportMemory: async (...args) => agentApi().agentWeeklyReportMemory(...args),
    workspaceInfo: async (...args) => agentApi().workspaceInfo(...args),
    githubCredential: async (...args) => agentApi().githubCredential(...args),
    githubCommitTrailers: async (...args) => agentApi().githubCommitTrailers(...args),
    version: async (...args) => requireRuntime().version(...args),
    computerUpdateNotice: async (...args) => localQueries().computerUpdateNotice(...args),
    ...workspaceRuntime(agentApi),
    ...appRuntime(agentApi),
    agentTeamMemory: async (...args) => agentApi().agentTeamMemory(...args),
    agentArtifact: async (...args) => agentApi().agentArtifact(...args),
    agentArtifactUpload: async (context, request, key) =>
      agentApi().agentArtifact(context, { file: "upload", ...request }, key),
    agentArtifactDownload: async (context, request, key) =>
      agentApi().agentArtifact(context, { file: "download", ...request }, key),
    issueAgentContext: (agentId) => requireRuntime().issueAgentContext(agentId),
    isAgentSessionRunning: (agentId) => {
      const runtime = requireRuntime();
      return agentSessionIsLive(
        {
          isRunning: (id) => runtime.agentProcessManager.isRunning(id),
          launch: (id) => runtime.currentActivityLaunch(id),
        },
        agentId,
      );
    },
    collab: createCollabHooks(requireRuntime),
  };
}
