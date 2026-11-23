export type UpgradeAttempt = { computerId: string; requestId: string };

export type UpgradeBinding = { workspaceId: string; bindingId: string };

export type UpgradeReporter = UpgradeAttempt & UpgradeBinding;

export type RegisteredUpgradeBinding = UpgradeBinding & { previousWorkerId?: string };

type BindingState = "running" | "stopped" | "unknown";

type Evidence = { generation: string; version: string; at: number };

export type UpgradeMachineEvidence = Evidence &
  (
    | { kind: "phase"; phase: "downloading" | "verifying" | "waiting" | "switching" | "uncertain" }
    | { kind: "snapshot"; bindings: { workspaceId: string; state: BindingState }[] }
    | { kind: "healthy" }
    | {
        kind: "receipt";
        outcome: "promoted" | "rolled_back" | "failed" | "unresolved";
        oldProcesses: "verified" | "none" | "unknown";
        restoredVersion?: string;
      }
  );

export type UpgradeReadyEvidence = UpgradeReporter & {
  generation: string;
  version: string;
  workerId: string;
  readyRequestId: string;
  confirmedAt: number;
  expiresAt: number;
};

type Record = {
  origin: UpgradeBinding;
  expectedVersion: string;
  expiresAt: number;
  bindings: RegisteredUpgradeBinding[];
  snapshot?: Extract<UpgradeMachineEvidence, { kind: "snapshot" }>;
  phase?: Extract<UpgradeMachineEvidence, { kind: "phase" }>;
  healthy?: Evidence & { receivedAt: number };
  receipts: Extract<UpgradeMachineEvidence, { kind: "receipt" }>[];
  ready: UpgradeReadyEvidence[];
};

export type UpgradeWorkspaceState = {
  workspaceId: string;
} & (
  | { state: "waiting" | "unconfirmed" | "not_running" | "unknown" }
  | { state: "restored"; confirmedAt: number }
);

export type ComputerUpgradeProgress = {
  expectedVersion: string;
  expiresAt: number;
  phase?: Extract<UpgradeMachineEvidence, { kind: "phase" }>["phase"];
  phaseAt?: number;
  switchState:
    | "pending"
    | "target_online"
    | "confirmed"
    | "rolled_back"
    | "failed"
    | "conflict"
    | "uncertain";
  workspaces: UpgradeWorkspaceState[];
  restoredVersion?: string;
  reconnectUntil?: number;
};

export interface UpgradeProgressPersistence {
  read(key: string): Promise<string | null>;
  readMany(keys: string[]): Promise<Array<string | null>>;
  replace(
    key: string,
    previous: string | null,
    next: string,
    retainUntil: number,
  ): Promise<boolean>;
}

function hasProgressEvidence(record: Record) {
  return Boolean(
    record.phase ||
    record.snapshot ||
    record.healthy ||
    record.receipts.length ||
    record.ready.length,
  );
}

const RECONNECT_MS = 120_000;
const RETAIN_MS = 600_000;
const phaseOrder = ["downloading", "verifying", "waiting", "switching", "uncertain"] as const;

const sameBinding = (a: UpgradeBinding, b: UpgradeBinding) =>
  a.workspaceId === b.workspaceId && a.bindingId === b.bindingId;

function reconnectDeadline(record: Record) {
  return Math.min(record.expiresAt, (record.healthy?.receivedAt ?? Infinity) + RECONNECT_MS);
}

function workspaceState(
  record: Record,
  row: RegisteredUpgradeBinding,
  now: number,
): UpgradeWorkspaceState {
  const workspaceId = row.workspaceId;
  const state = record.snapshot?.bindings.find(
    (binding) => binding.workspaceId === workspaceId,
  )?.state;
  if (state === "stopped") return { workspaceId, state: "not_running" };
  if (state !== "running" || !row.previousWorkerId) return { workspaceId, state: "unknown" };
  const confirmed = record.ready.find(
    (evidence) => sameBinding(row, evidence) && evidence.generation === record.snapshot?.generation,
  );
  if (confirmed) return { workspaceId, state: "restored", confirmedAt: confirmed.confirmedAt };
  return { workspaceId, state: now < reconnectDeadline(record) ? "waiting" : "unconfirmed" };
}

function rolledBackVersions(record: Record) {
  return new Set(
    record.receipts
      .filter((receipt) => receipt.outcome === "rolled_back")
      .map((receipt) => receipt.restoredVersion)
      .filter((version) => version !== undefined),
  );
}

function switchState(
  record: Record,
  targetOnline: boolean,
): ComputerUpgradeProgress["switchState"] {
  const outcomes = new Set(
    record.receipts.map((receipt) => receipt.outcome).filter((outcome) => outcome !== "unresolved"),
  );
  if (outcomes.size > 1) return "conflict";
  if (outcomes.has("rolled_back"))
    return targetOnline || rolledBackVersions(record).size > 1 ? "conflict" : "rolled_back";
  if (outcomes.has("failed")) return targetOnline ? "conflict" : "failed";
  if (!outcomes.size && (record.receipts.length || record.phase?.phase === "uncertain"))
    return "uncertain";
  if (!targetOnline) return "pending";
  return record.receipts.some(
    (receipt) => receipt.outcome === "promoted" && receipt.oldProcesses !== "unknown",
  )
    ? "confirmed"
    : "target_online";
}

type EvidenceResult = "stored" | "rejected" | "expired";
type Mutation = { record: Record; result: EvidenceResult };

export class ComputerUpgradeProgressStore {
  constructor(
    private readonly persistence: UpgradeProgressPersistence,
    private readonly now = Date.now,
  ) {}

  async begin(
    origin: UpgradeReporter,
    expectedVersion: string,
    expiresAt: number,
    bindings: RegisteredUpgradeBinding[],
  ) {
    const record: Record = {
      origin: { workspaceId: origin.workspaceId, bindingId: origin.bindingId },
      expectedVersion,
      expiresAt,
      bindings,
      ready: [],
      receipts: [],
    };
    if (!bindings.some((binding) => sameBinding(binding, origin))) return;
    await this.persistence.replace(
      this.key(origin),
      null,
      JSON.stringify(record),
      expiresAt + RETAIN_MS,
    );
  }

  async recordMachine(reporter: UpgradeReporter, evidence: UpgradeMachineEvidence) {
    return this.update(reporter, (record, now) => {
      if (!sameBinding(record.origin, reporter) || evidence.version !== record.expectedVersion)
        return { record, result: "rejected" };
      const generation =
        record.snapshot?.generation ??
        record.healthy?.generation ??
        record.receipts[0]?.generation ??
        record.phase?.generation;
      if (generation && generation !== evidence.generation) return { record, result: "rejected" };
      switch (evidence.kind) {
        case "snapshot":
          if (record.snapshot) return { record, result: "stored" };
          return {
            record: {
              ...record,
              snapshot: evidence,
              ready: record.ready.filter((row) => row.generation === evidence.generation),
            },
            result: "stored",
          };
        case "phase":
          if (
            record.phase &&
            phaseOrder.indexOf(record.phase.phase) >= phaseOrder.indexOf(evidence.phase)
          )
            return { record, result: "stored" };
          return { record: { ...record, phase: evidence }, result: "stored" };
        case "healthy":
          if (record.healthy) return { record, result: "stored" };
          return {
            record: { ...record, healthy: { ...evidence, receivedAt: now } },
            result: "stored",
          };
        case "receipt":
          if (evidence.outcome === "rolled_back" && evidence.restoredVersion) {
            const versions = rolledBackVersions(record);
            if (versions.size > 1 && !versions.has(evidence.restoredVersion))
              return { record, result: "stored" };
          }
          if (
            record.receipts.some(
              (receipt) =>
                receipt.outcome === evidence.outcome &&
                receipt.oldProcesses === evidence.oldProcesses &&
                receipt.restoredVersion === evidence.restoredVersion,
            )
          )
            return { record, result: "stored" };
          return {
            record: { ...record, receipts: [...record.receipts, evidence] },
            result: "stored",
          };
      }
    });
  }

  async identifyReady(reporter: UpgradeReporter, generation: string) {
    const { record } = await this.load(reporter);
    if (
      !record ||
      this.now() >= reconnectDeadline(record) ||
      (record.snapshot && record.snapshot.generation !== generation) ||
      record.ready.some((row) => sameBinding(row, reporter) && row.generation === generation)
    )
      return;
    const binding = record.bindings.find((row) => sameBinding(row, reporter));
    return binding?.previousWorkerId
      ? {
          expectedVersion: record.expectedVersion,
          expiresAt: record.expiresAt,
          previousWorkerId: binding.previousWorkerId,
        }
      : undefined;
  }

  async recordReady(reporter: UpgradeReporter, evidence: UpgradeReadyEvidence) {
    return this.update(reporter, (record, now) => {
      const binding = record.bindings.find((row) => sameBinding(row, reporter));
      if (
        !sameBinding(reporter, evidence) ||
        evidence.computerId !== reporter.computerId ||
        evidence.requestId !== reporter.requestId ||
        !binding?.previousWorkerId ||
        binding.previousWorkerId === evidence.workerId ||
        evidence.version !== record.expectedVersion ||
        evidence.expiresAt !== record.expiresAt ||
        evidence.confirmedAt >= evidence.expiresAt ||
        (record.snapshot && evidence.generation !== record.snapshot.generation)
      )
        return { record, result: "rejected" };
      if (now >= reconnectDeadline(record)) return { record, result: "expired" };
      if (
        record.ready.some(
          (entry) => sameBinding(entry, evidence) && entry.generation === evidence.generation,
        )
      )
        return { record, result: "stored" };
      if (record.ready.filter((entry) => sameBinding(entry, evidence)).length >= 4)
        return { record, result: "rejected" };
      return { record: { ...record, ready: [...record.ready, evidence] }, result: "stored" };
    });
  }

  async read(
    attempt: UpgradeAttempt,
    visibleBindingIds: readonly string[],
    terminalStatus?: "completed" | "failed" | null,
  ): Promise<ComputerUpgradeProgress | undefined> {
    const { record } = await this.load(attempt);
    if (!record) return;
    if ((terminalStatus === "completed" || terminalStatus === null) && !hasProgressEvidence(record))
      return;
    const now = this.now();
    const restoredVersions = rolledBackVersions(record);
    const restoredVersion = restoredVersions.size === 1 ? [...restoredVersions][0] : undefined;
    const visible = new Set(visibleBindingIds);
    const workspaces = record.snapshot
      ? record.bindings
          .filter((row) => visible.has(row.bindingId))
          .map((row) => workspaceState(record, row, now))
      : [];
    const targetOnline =
      terminalStatus === "completed" || workspaces.some((row) => row.state === "restored");
    const state = switchState(record, targetOnline);
    if (terminalStatus === "failed" && state === "pending") return;
    const reconnectUntil =
      workspaces.some((row) => row.state === "waiting") && record.healthy
        ? reconnectDeadline(record)
        : undefined;
    return {
      expectedVersion: record.expectedVersion,
      expiresAt: record.expiresAt,
      ...(record.phase ? { phase: record.phase.phase, phaseAt: record.phase.at } : {}),
      switchState: now >= record.expiresAt && state === "pending" ? "uncertain" : state,
      ...(restoredVersion ? { restoredVersion } : {}),
      workspaces,
      ...(reconnectUntil === undefined ? {} : { reconnectUntil }),
    };
  }

  async hasEvidenceMany(attempts: readonly UpgradeAttempt[]) {
    if (!attempts.length) return [];
    const records = await this.persistence.readMany(attempts.map((attempt) => this.key(attempt)));
    return records.map((raw) => {
      if (raw === null) return false;
      try {
        return hasProgressEvidence(JSON.parse(raw) as Record);
      } catch {
        return false;
      }
    });
  }

  private async update(attempt: UpgradeAttempt, apply: (record: Record, now: number) => Mutation) {
    for (let pass = 0; pass < 8; pass += 1) {
      const { key, raw, record } = await this.load(attempt);
      if (!record || raw === null || this.now() >= record.expiresAt) return "expired";
      const result = apply(record, this.now());
      if (
        result.record === record ||
        (await this.persistence.replace(
          key,
          raw,
          JSON.stringify(result.record),
          record.expiresAt + RETAIN_MS,
        ))
      )
        return result.result;
    }
    throw new Error("Computer upgrade progress changed concurrently");
  }

  private async load(attempt: UpgradeAttempt) {
    const key = this.key(attempt);
    const raw = await this.persistence.read(key);
    const record = raw === null ? undefined : (JSON.parse(raw) as Record);
    return { key, raw, record };
  }

  private key({ computerId, requestId }: UpgradeAttempt) {
    return `coforge:computer:${encodeURIComponent(computerId)}:upgrade-progress:v1:${encodeURIComponent(requestId)}`;
  }
}
