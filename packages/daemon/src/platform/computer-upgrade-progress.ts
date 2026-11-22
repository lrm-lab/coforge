import { link, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { installerJournalPath } from "./installer-journal";
import { RFC_UUID_PATTERN, type ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";

export type UpgradeActivation = {
  observedUpgradeRequestId: string;
  upgradeActivationGeneration: string;
};

export function upgradeReadyReceiptDirectory(stateDirectory: string) {
  return join(stateDirectory, "upgrade-ready-receipts");
}

export function upgradeReadyReceiptName(activation: UpgradeActivation) {
  return `ready-${activation.observedUpgradeRequestId.toLowerCase()}-${activation.upgradeActivationGeneration.toLowerCase()}.json`;
}

export const UPGRADE_EVIDENCE_WINDOW_MS = 600_000;
export const UPGRADE_PHASE_FILES = [
  "downloading",
  "verifying",
  "snapshot",
  "waiting",
  "switching",
  "uncertain",
  "healthy",
  "receipt",
  "recovery",
] as const;

type UpgradeContext = {
  originWorkspaceId: string;
  generation: string;
  version: string;
  expiresAt: number;
};

export function computerUpgradeProgressRoot(installRoot: string) {
  return join(installRoot, "upgrade-progress");
}

export async function readUpgradeProgressFile<T>(
  path: string,
  maxBytes = 16_384,
): Promise<T | undefined> {
  try {
    const file = Bun.file(path);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) return;
    return JSON.parse(await file.text()) as T;
  } catch {
    return;
  }
}

export async function writeUpgradeProgressFile(
  directory: string,
  name: string,
  value: unknown,
  replace = true,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, name);
  const path = join(directory, `.${crypto.randomUUID()}.tmp`);
  const handle = await open(path, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (replace) await rename(path, destination);
    else await link(path, destination);
  } finally {
    await rm(path, { force: true });
  }
}

export async function beginLocalUpgradeProgress(
  installRoot: string,
  originWorkspaceId: string,
  requestId: string,
  version: string,
) {
  if (!RFC_UUID_PATTERN.test(requestId)) return;
  const root = computerUpgradeProgressRoot(installRoot);
  const normalizedId = requestId.toLowerCase();
  await writeUpgradeProgressFile(
    join(root, normalizedId),
    "context.json",
    {
      originWorkspaceId,
      generation: crypto.randomUUID(),
      version,
      expiresAt: Date.now() + UPGRADE_EVIDENCE_WINDOW_MS,
    } satisfies UpgradeContext,
    false,
  );
  await writeUpgradeProgressFile(root, "latest.json", { requestId: normalizedId });
  void pruneExpiredProgress(root, normalizedId).catch(() => {});
}

async function pruneExpiredProgress(root: string, currentId: string) {
  for (const id of await readdir(root)) {
    if (id === currentId || !RFC_UUID_PATTERN.test(id)) continue;
    const directory = join(root, id);
    const context = await readUpgradeProgressFile<UpgradeContext>(join(directory, "context.json"));
    const started = await stat(directory).then(
      (info) => info.mtimeMs,
      () => Date.now(),
    );
    if ((context?.expiresAt ?? started + UPGRADE_EVIDENCE_WINDOW_MS) <= Date.now())
      await rm(directory, { recursive: true, force: true });
  }
}

export async function readLocalUpgradeContext(installRoot: string, requestId: string) {
  if (!RFC_UUID_PATTERN.test(requestId)) return;
  const directory = join(computerUpgradeProgressRoot(installRoot), requestId.toLowerCase());
  const context = await readUpgradeProgressFile<UpgradeContext>(join(directory, "context.json"));
  if (!context || !RFC_UUID_PATTERN.test(context.generation) || context.expiresAt <= Date.now())
    return;
  return { directory, context };
}

export async function snapshotUpgradeBindings(
  installRoot: string,
  requestId: string,
  workspaces: () => Promise<ManagedRuntimeIdentity[]>,
) {
  const attempt = await readLocalUpgradeContext(installRoot, requestId);
  if (!attempt || (await Bun.file(join(attempt.directory, "snapshot.json")).exists())) return;
  const bindings = (await workspaces()).slice(0, 128).map((workspace) => ({
    workspaceId: workspace.workspaceId,
    state: workspace.lifecycleUnderWay
      ? "unknown"
      : workspace.processId > 0
        ? "running"
        : workspace.enabled
          ? "unknown"
          : "stopped",
  }));
  const { version, generation } = attempt.context;
  await writeUpgradeProgressFile(
    attempt.directory,
    "snapshot.json",
    {
      kind: "snapshot",
      at: Date.now(),
      version,
      generation,
      bindings,
    },
    false,
  );
}

export async function readUpgradeActivation(
  installRoot: string,
  currentVersion: string,
  startedAt: number,
): Promise<UpgradeActivation | undefined> {
  const journal = await readUpgradeProgressFile<{ request_id: string; to: string }>(
    installerJournalPath(installRoot),
  );
  const latest = journal
    ? { requestId: journal.request_id }
    : await readUpgradeProgressFile<{ requestId: string }>(
        join(computerUpgradeProgressRoot(installRoot), "latest.json"),
      );
  if (!latest || (journal && journal.to !== currentVersion)) return;
  const attempt = await readLocalUpgradeContext(installRoot, latest.requestId);
  if (!attempt || attempt.context.version !== currentVersion) return;
  type Marker = { kind: string; generation: string; version: string; at: number; outcome?: string };
  const marker = (name: string) =>
    readUpgradeProgressFile<Marker>(join(attempt.directory, `${name}.json`));
  const [activated, receipt, recovery] = await Promise.all([
    marker("activated"),
    marker("receipt"),
    marker("recovery"),
  ]);
  const matches = (value: Marker | undefined): value is Marker =>
    value?.generation === attempt.context.generation &&
    value.version === currentVersion &&
    Number.isFinite(value.at);
  if (!matches(activated) || activated.kind !== "activated" || activated.at >= startedAt) return;
  const closed = [receipt, recovery]
    .filter(matches)
    .reduce(
      (at, value) =>
        value.kind === "receipt" &&
        (value.outcome === "promoted" ||
          value.outcome === "rolled_back" ||
          value.outcome === "failed") &&
        value.at >= activated.at
          ? Math.min(at, value.at)
          : at,
      Infinity,
    );
  if ((!journal && closed === Infinity) || startedAt >= closed) return;
  return {
    observedUpgradeRequestId: latest.requestId,
    upgradeActivationGeneration: attempt.context.generation,
  };
}

export async function recordInstallerBootstrapProgress(
  installRoot: string,
  requestId: string,
  state: "downloading" | "failed",
) {
  const attempt = await readLocalUpgradeContext(installRoot, requestId);
  if (!attempt) return;
  const { generation, version } = attempt.context;
  const fact =
    state === "downloading"
      ? { kind: "phase", phase: state }
      : { kind: "receipt", outcome: "failed", oldProcesses: "unknown" };
  await writeUpgradeProgressFile(
    attempt.directory,
    state === "downloading" ? "downloading.json" : "receipt.json",
    {
      ...fact,
      generation,
      version,
      at: Date.now(),
    },
  );
}
