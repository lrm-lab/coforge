import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import { escapePathIdentity, isSafePathScope } from "./path-scope";

const logger = getLogger(["coforge", "daemon", "attention-decisions"]);

/** One decision the attention index made for one delivery to one Agent. */
export type AgentAttentionDecisionRecord = Readonly<{
  at: string;
  agentId: string;
  messageId: string;
  deliveryId: string;
  target: string;
  sequence: number;
  outcome: "notified" | "held" | "consumed" | "already_notified";
}>;

/** Append-only journal the attention index writes to; best-effort, never throws. */
export type AgentAttentionDecisionPort = Readonly<{
  append(record: AgentAttentionDecisionRecord): void;
  read(agentId: string): AgentAttentionDecisionRecord[];
}>;

/**
 * The daemon's durable copy of its attention decisions, one JSON line per decision
 * (`attention-decisions.jsonl`), next to `consumed-seqs.json`. Nothing in the daemon reads it:
 * it exists so a later consumer (the memory sink) can tell which messages an Agent was notified
 * of and which its cursor already covered. A lost line costs one fact, never a delivery.
 */
export class AgentAttentionDecisionStore implements AgentAttentionDecisionPort {
  readonly #root: string;

  constructor(rootDirectory = Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR ?? tmpdir()) {
    if (!rootDirectory) throw new Error("attention-decision state directory is required");
    this.#root = rootDirectory;
  }

  #path(agentId: string): string {
    if (!isSafePathScope(agentId)) throw new Error("invalid attention-decision Agent scope");
    return join(
      this.#root,
      `coforge-cli-consumed-seq-${escapePathIdentity(String(process.geteuid?.() ?? userInfo().username))}`,
      escapePathIdentity(agentId),
      "attention-decisions.jsonl",
    );
  }

  append(record: AgentAttentionDecisionRecord): void {
    try {
      const path = this.#path(record.agentId);
      for (const directory of [dirname(dirname(path)), dirname(path)]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const status = lstatSync(directory);
        if (status.isSymbolicLink() || !status.isDirectory())
          throw new Error("attention-decision directory must be a real directory");
        chmodSync(directory, 0o700);
      }
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      logger.warn("could not persist an attention decision", {
        event: "message.attention_decision_write_failed",
        agent_id: record.agentId,
        error: thrownMessage(error),
      });
    }
  }

  read(agentId: string): AgentAttentionDecisionRecord[] {
    let text: string;
    try {
      text = readFileSync(this.#path(agentId), "utf8");
    } catch {
      return [];
    }
    const records: AgentAttentionDecisionRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as AgentAttentionDecisionRecord;
        if (typeof value?.messageId === "string" && typeof value.outcome === "string")
          records.push(value);
      } catch {
        // A half-written last line is skipped.
      }
    }
    return records;
  }
}
