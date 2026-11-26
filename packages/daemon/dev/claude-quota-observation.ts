import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeQuotaObservation,
  ClaudeQuotaObservationOptIn,
} from "@lrm/coforge-anvil/claude-code";

const maxAgeMs = 24 * 60 * 60 * 1000;
const segmentBytes = 64 * 1024;
const opaqueId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const version = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:dev|alpha|beta|rc|canary)\.\d{1,6})?$/;

type NonProductionApproval = Readonly<{
  environment: "non-production";
  runtimeId: string;
  approverId: string;
  approvedAt: string;
  computerGroup: string;
  accountGroup?: string;
  adapterVersion: string;
  cliVersion?: string;
}>;

export function openClaudeQuotaObservation(approval: NonProductionApproval): {
  optIn: ClaudeQuotaObservationOptIn;
  directory: string;
  close: () => void;
} {
  const {
    environment,
    runtimeId,
    approverId,
    approvedAt,
    computerGroup,
    accountGroup,
    adapterVersion,
    cliVersion,
  } = approval;
  const approvedAtMs = Date.parse(approvedAt);
  const now = Date.now();
  const expiresAt = approvedAtMs + maxAgeMs;
  if (
    environment !== "non-production" ||
    !opaqueId.test(runtimeId) ||
    !opaqueId.test(approverId) ||
    !opaqueId.test(computerGroup) ||
    (accountGroup !== undefined && !opaqueId.test(accountGroup)) ||
    !version.test(adapterVersion) ||
    (cliVersion !== undefined && !version.test(cliVersion)) ||
    !Number.isFinite(expiresAt) ||
    approvedAtMs > now ||
    expiresAt <= now
  ) {
    throw new Error("A current non-production Claude observation approval is required");
  }

  const directory = mkdtempSync(join(tmpdir(), "coforge-claude-quota-"));
  const launch = crypto.randomUUID();
  try {
    writeFileSync(
      join(directory, "approval.json"),
      JSON.stringify({
        approverId,
        approvedAt: new Date(approvedAtMs).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        runtimeId,
        launch,
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const active = join(directory, "observations.jsonl");
  const previous = join(directory, "observations.1.jsonl");
  let bytes = 0;
  let closed = false;
  const cleanup = () => {
    try {
      close();
    } catch {
      return;
    }
  };
  const expiry = setTimeout(cleanup, expiresAt - now).unref();
  process.once("exit", cleanup);

  function close(): void {
    closed = true;
    clearTimeout(expiry);
    process.off("exit", cleanup);
    rmSync(directory, { recursive: true, force: true });
  }

  function observe(fact: ClaudeQuotaObservation): void {
    if (closed) return;
    if (Date.now() >= expiresAt) {
      close();
      return;
    }
    const observation =
      fact.type === "quota_window"
        ? { type: fact.type, window: fact.window, status: fact.status, resetsAt: fact.resetsAt }
        : { type: fact.type, afterWindowRejection: fact.afterWindowRejection };
    const line =
      JSON.stringify({
        observedAt: fact.observedAt,
        launch,
        computerGroup,
        accountGroup: accountGroup ?? "unknown",
        adapterVersion,
        cliVersion: cliVersion ?? "unknown",
        ...observation,
      }) + "\n";
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > segmentBytes) return;
    if (bytes + lineBytes > segmentBytes) {
      renameSync(active, previous);
      bytes = 0;
    }
    appendFileSync(active, line, { mode: 0o600 });
    bytes += lineBytes;
  }

  return { optIn: { runtimeId, observe }, directory, close };
}
