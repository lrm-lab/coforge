import { readWorkspaceUpgradeActivation } from "#src/supervisor/workspace-upgrade-recovery";
import { resolveComputerInstallDirectory } from "#src/platform/computer-install-directory";
import type { DaemonConfig } from "./runtime-connection-config";
import type { DaemonRuntimeLifecycle } from "./runtime-lifecycle";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  computerUpgradeProgressRoot,
  readLocalUpgradeContext,
  readUpgradeProgressFile,
  UPGRADE_EVIDENCE_WINDOW_MS,
  UPGRADE_PHASE_FILES,
  writeUpgradeProgressFile,
} from "#src/platform/computer-upgrade-progress";

type Receipt = { receipt: string; expiresAt: number };

type Attempt = { reported: Set<string>; expiresAt: number };

export class UpgradeProgressReporter {
  readonly #attempts = new Map<string, Attempt>();
  readonly #receiptDirectory: string;
  #timer?: ReturnType<typeof setTimeout>;
  #reporting = false;
  #rerun = false;

  constructor(
    private readonly options: {
      installRoot: string;
      stateDirectory: string;
      workspaceId: string;
      endpoint: URL;
      apiKey: string;
      signal: AbortSignal;
    },
  ) {
    this.#receiptDirectory = join(options.stateDirectory, "upgrade-ready-receipts");
    options.signal.addEventListener("abort", () => clearTimeout(this.#timer), { once: true });
  }

  async resume(requestIds: readonly string[]) {
    const latest = await readUpgradeProgressFile<{ requestId: string }>(
      join(computerUpgradeProgressRoot(this.options.installRoot), "latest.json"),
    );
    for (const id of new Set([...(latest ? [latest.requestId] : []), ...requestIds]))
      await this.track(id);
    this.#schedule(0);
  }

  async track(requestId: string) {
    if (this.#attempts.has(requestId)) return;
    const attempt = await readLocalUpgradeContext(this.options.installRoot, requestId);
    if (attempt?.context.originWorkspaceId !== this.options.workspaceId) return;
    this.#attempts.set(requestId, { reported: new Set(), expiresAt: attempt.context.expiresAt });
    this.#schedule(0);
  }

  async acceptReceipt(receipt: string) {
    if (!receipt || receipt.length > 2048 || this.options.signal.aborted) return;
    const data: Receipt = { receipt, expiresAt: Date.now() + UPGRADE_EVIDENCE_WINDOW_MS };
    await writeUpgradeProgressFile(
      this.#receiptDirectory,
      `${Bun.hash(receipt).toString(16)}.json`,
      data,
    );
    this.#schedule(0);
  }

  #schedule(delay: number) {
    if (this.#timer || this.options.signal.aborted) return;
    if (this.#reporting) {
      this.#rerun = true;
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, delay);
    this.#timer.unref?.();
  }

  async #flush() {
    if (this.options.signal.aborted) return;
    this.#reporting = true;
    let pendingReceipts = false;
    try {
      const receipts = await readdir(this.#receiptDirectory).catch(() => []);
      for (const name of receipts) {
        if (!/^[a-f0-9]+\.json$/.test(name) || this.options.signal.aborted) continue;
        const path = join(this.#receiptDirectory, name);
        const receipt = await readUpgradeProgressFile<Receipt>(path, 4096);
        if (
          !receipt ||
          receipt.expiresAt <= Date.now() ||
          (await this.#post({ kind: "ready", receipt: receipt.receipt }))
        ) {
          await rm(path, { force: true }).catch(() => {});
        } else pendingReceipts = true;
      }
      for (const [requestId, attempt] of this.#attempts) {
        if (this.options.signal.aborted) break;
        const local = await readLocalUpgradeContext(this.options.installRoot, requestId);
        if (!local || attempt.expiresAt <= Date.now()) {
          this.#attempts.delete(requestId);
          continue;
        }
        const names = UPGRADE_PHASE_FILES.filter((name) => !attempt.reported.has(name));
        const events = (
          await Promise.all(
            names.map(async (name) => {
              const event = await readUpgradeProgressFile<unknown>(
                join(local.directory, `${name}.json`),
              );
              return event ? [{ name, event }] : [];
            }),
          )
        ).flat();
        if (
          events.length &&
          (await this.#post({
            kind: "machine",
            requestId,
            events: events.map(({ event }) => event),
          }))
        ) {
          for (const { name } of events) attempt.reported.add(name);
        }
      }
    } finally {
      this.#reporting = false;
      if (this.#rerun) {
        this.#rerun = false;
        this.#schedule(0);
      } else if (pendingReceipts || this.#attempts.size) this.#schedule(2_000);
    }
  }

  async #post(body: unknown) {
    try {
      const response = await fetch(this.options.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(3_000)]),
      });
      return (
        response.ok ||
        response.status === 400 ||
        response.status === 403 ||
        response.status === 404 ||
        response.status === 410
      );
    } catch {
      return false;
    }
  }
}

export function startUpgradeProgressReporter(
  connection: DaemonConfig,
  lifecycle: Pick<DaemonRuntimeLifecycle, "requestUpgrade" | "recoveredUpgradeRequestIds">,
  stateDirectory: string,
  apiKey: string,
  signal: AbortSignal,
  version: string,
  startedAt: number,
) {
  const { requestUpgrade } = lifecycle;
  if (!connection.serverHttpUrl || !requestUpgrade) return;
  const installRoot = resolveComputerInstallDirectory();
  const reporter = new UpgradeProgressReporter({
    installRoot,
    stateDirectory,
    workspaceId: connection.workspaceId,
    endpoint: new URL("/api/daemon/computer-upgrade-progress", connection.serverHttpUrl),
    apiKey,
    signal,
  });
  void reporter.resume(lifecycle.recoveredUpgradeRequestIds ?? []).catch(() => {});
  return {
    activation: readWorkspaceUpgradeActivation(
      installRoot,
      stateDirectory,
      connection,
      version,
      startedAt,
      signal,
    ),
    acceptReceipt: (receipt: string) => {
      void reporter.acceptReceipt(receipt).catch(() => {});
    },
    requestUpgrade: async (...args: Parameters<typeof requestUpgrade>) => {
      try {
        await requestUpgrade(...args);
      } finally {
        void reporter.track(args[0]).catch(() => {});
      }
    },
  };
}
