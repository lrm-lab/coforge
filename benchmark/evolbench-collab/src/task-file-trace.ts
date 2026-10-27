import { admittedSessionWriteFromDelivery } from "../../../apps/web/src/server/workspace-memory/ov-sink.server";
import type { AdmissionSinkDelivery } from "../../../apps/web/src/server/workspace-memory/dispatch";
import type { EpisodeEnrichment } from "./enrichment";
import { readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { trainingTrajectoryFromFile } from "../../../packages/agent/src/training-trajectory";
import {
  channelTraceFromSteps,
  type ChannelToolExchange,
} from "../../../packages/agent/src/channel-turn-trace";
import type { OpenVikingAdmittedSessionWrite } from "../../../apps/web/src/server/openviking/typed-session-extract.server";

export type TrailingObservation = {
  sessionId: string;
  participantId: string;
  toolExchanges: readonly ChannelToolExchange[];
};

/** Read only the dedicated agent directory. Docker metadata bridges host cwd to Pi cwd. */
export async function exportTaskFileTrace(input: { cwd: string; sessionId: string }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(input.sessionId))
    throw new Error("Invalid Task session ID");
  const workspace = await realpath(input.cwd);
  const dir = join(workspace, ".builtin-sessions");
  const runtime = await Bun.file(join(workspace, "docker-task-runtime.json")).json();
  if (
    runtime.hostWorkspace !== workspace ||
    runtime.sessionDirectory !== dir ||
    typeof runtime.cwd !== "string" ||
    !runtime.cwd.startsWith("/") ||
    (runtime.sessionId !== undefined && runtime.sessionId !== input.sessionId) ||
    (await realpath(dir)) !== dir
  )
    throw new Error("Task runtime identity mismatch");
  let matched: string | undefined;
  for (const name of (await readdir(dir)).filter((name) => name.endsWith(".jsonl"))) {
    const path = join(dir, name);
    if ((await realpath(path)) !== resolve(path))
      throw new Error("Task session escapes agent directory");
    const content = await Bun.file(path).text();
    const entries = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string")
      throw new Error("Invalid Task session header");
    if (header.id !== input.sessionId) continue;
    if (header.version !== 3)
      throw new Error("Task session version requires migration; read-only export refused");
    if (header.cwd !== runtime.cwd) throw new Error("Task session cwd identity mismatch");
    if (matched) throw new Error("Ambiguous Task session identity");
    matched = path;
  }
  if (!matched) throw new Error("Task session not found in agent directory");
  const trajectory = trainingTrajectoryFromFile(matched, dir, runtime.cwd);
  if (trajectory.sessionId !== input.sessionId) throw new Error("Task session identity changed");
  return channelTraceFromSteps(input.sessionId, trajectory.steps, true);
}

/** Independent training observations with a stable runtime source id, never a channel receipt. */
export function appendTrailingObservations(
  write: OpenVikingAdmittedSessionWrite,
  observations: readonly TrailingObservation[],
): OpenVikingAdmittedSessionWrite {
  if (observations.length === 0) return write;
  return {
    ...write,
    messages: [
      ...write.messages,
      ...observations.map((observation) => ({
        role: "assistant" as const,
        content:
          `[Task runtime observation; not published to channel; session=${observation.sessionId}]` +
          (observation.toolExchanges.some((tool) => tool.resultUnavailable)
            ? `\nInvoked tools with no result at snapshot (completion unknown): ${JSON.stringify(observation.toolExchanges.filter((tool) => tool.resultUnavailable).map((tool) => ({ toolCallId: tool.toolCallId, toolName: tool.toolName, input: tool.input })))}`
            : ""),
        createdAt: write.messages.at(-1)?.createdAt ?? "1970-01-01T00:00:00.000Z",
        sourceMessageIds: [
          `runtime-observation:${observation.sessionId}:${new Bun.CryptoHasher("sha256").update(JSON.stringify(observation.toolExchanges)).digest("hex")}`,
        ],
        peerId: observation.participantId,
        derived: true,
        toolExchanges: observation.toolExchanges.filter((tool) => !tool.resultUnavailable),
      })),
    ],
  };
}

export function trajectorySessionWrite(delivery: AdmissionSinkDelivery) {
  const enrichment = delivery.turnEnrichment as EpisodeEnrichment | undefined;
  const observations = delivery.turns.some(
    (turn) => turn.messageId === enrichment?.trailingAnchorMessageId,
  )
    ? enrichment?.trailingObservations
    : undefined;
  return appendTrailingObservations(admittedSessionWriteFromDelivery(delivery), observations ?? []);
}
