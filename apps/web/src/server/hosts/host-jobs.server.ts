export class HostJobError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = "HostJobError";
  }
}

export type CloudSlot = "default" | "extra";
export type HostJobOperation = "create" | "delete" | "attach";

export type CloudComputer = {
  id: string;
  ownerId: string;
  slot: CloudSlot;
  /** The Workspace an extra computer is for. The default computer has none. */
  homeWorkspaceId: string | null;
  name: string;
  /** The name the owner types to confirm formatting. Empty falls back to `name`. */
  displayName: string;
  containerReady: boolean;
  deletedAt: Date | null;
};

/** What a signed-in user sees. The daemon key is never on this object. */
export type CloudComputerView = {
  computerId: string;
  slot: CloudSlot;
  name: string;
  containerReady: boolean;
  jobId: string | null;
};

export type HostJobRecord = {
  id: string;
  clusterId: string;
  operation: HostJobOperation;
  workspaceId: string;
  workspaceSlug: string;
  computerId: string;
  ownerId: string;
  idempotencyKey: string;
  name: string;
  daemonApiKey: string | null;
  containerId: string | null;
  createdAt: Date;
  reportedAt: Date | null;
};

export type ClaimedHostJob = {
  jobId: string;
  operation: HostJobOperation;
  computerId: string;
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  daemonApiKey: string | null;
};

export interface WorkspaceAccess {
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ id: string; slug: string } | undefined>;
}

export interface CloudFleet {
  list(ownerId: string): Promise<CloudComputer[]>;
  insert(computer: CloudComputer): Promise<void>;
  markReady(id: string): Promise<void>;
  markDeleted(id: string, at: Date): Promise<void>;
  /** The reported container is gone. The computer row stays. */
  forgetContainer(id: string): Promise<void>;
  linkedWorkspaces(computerId: string): Promise<Array<{ id: string; slug: string }>>;
  isLinked(computerId: string, workspaceId: string): Promise<boolean>;
  link(computerId: string, workspaceId: string, slug: string): Promise<void>;
}

export interface ClusterJobs {
  findByIdempotency(ownerId: string, idempotencyKey: string): Promise<HostJobRecord | undefined>;
  /** An unreported format removal for this computer, if one is already queued. */
  findOpenFormat(ownerId: string, computerId: string): Promise<HostJobRecord | undefined>;
  insert(record: HostJobRecord): Promise<void>;
  /** Drops open create and attach work once the computer is being removed. */
  abandon(computerId: string, now: Date): Promise<void>;
  next(clusterId: string, accepting: boolean): Promise<HostJobRecord | undefined>;
  save(record: HostJobRecord): Promise<void>;
  findById(id: string): Promise<HostJobRecord | undefined>;
}

export interface ClusterAuth {
  id(): Promise<string>;
  authenticate(token: string): Promise<{ id: string; accepting: boolean } | undefined>;
}

export interface DaemonKeys {
  issue(input: { userId: string; workspaceId: string; computerId: string }): Promise<string>;
}

const OPERATION_ORDER: Record<HostJobOperation, number> = { delete: 0, attach: 1, create: 2 };

export class HostJobs {
  constructor(
    private readonly deps: {
      workspaces: WorkspaceAccess;
      fleet: CloudFleet;
      jobs: ClusterJobs;
      cluster: ClusterAuth;
      keys: DaemonKeys;
      /** Drops provider sessions stored for this computer once its disk is gone. */
      disk?: { clear(computerId: string): Promise<void> };
    },
  ) {}

  async ensureDefault(input: {
    userId: string;
    workspaceId: string;
    now: Date;
  }): Promise<CloudComputerView> {
    const workspace = await this.#workspace(input.workspaceId, input.userId);
    const clusterId = await this.deps.cluster.id();
    const existing = active(await this.deps.fleet.list(input.userId)).find(
      (computer) => computer.slot === "default",
    );
    if (existing) {
      await this.#attachIfNeeded(existing, workspace, input.userId, clusterId, input.now);
      return view(existing, null);
    }
    return this.#create(input.userId, workspace, clusterId, "default", "Cloud", input.now);
  }

  async addExtra(input: {
    userId: string;
    workspaceId: string;
    now: Date;
  }): Promise<CloudComputerView> {
    const workspace = await this.#workspace(input.workspaceId, input.userId);
    const computers = active(await this.deps.fleet.list(input.userId));
    const ready = computers.find(
      (computer) => computer.slot === "default" && computer.containerReady,
    );
    if (!ready) throw new HostJobError(409, "default cloud computer is not ready");
    if (
      computers.some(
        (computer) => computer.slot === "extra" && computer.homeWorkspaceId === workspace.id,
      )
    ) {
      throw new HostJobError(409, "an extra cloud computer already exists");
    }
    return this.#create(
      input.userId,
      workspace,
      await this.deps.cluster.id(),
      "extra",
      "Cloud 2",
      input.now,
    );
  }

  async deleteExtra(input: {
    userId: string;
    workspaceId: string;
    computerId: string;
    now: Date;
  }): Promise<CloudComputerView> {
    const workspace = await this.#workspace(input.workspaceId, input.userId);
    const computer = (await this.deps.fleet.list(input.userId)).find(
      (item) => item.id === input.computerId && item.deletedAt === null,
    );
    if (!computer) throw new HostJobError(404, "cloud computer not found");
    if (computer.slot !== "extra")
      throw new HostJobError(409, "the default cloud computer cannot be deleted");
    const key = `cloud-delete:${computer.id}`;
    const existing = await this.deps.jobs.findByIdempotency(input.userId, key);
    if (existing) return view(computer, existing.id);
    const clusterId = await this.deps.cluster.id();
    const job = this.#job({
      clusterId,
      operation: "delete",
      workspace,
      computer,
      ownerId: input.userId,
      idempotencyKey: key,
      daemonApiKey: null,
      now: input.now,
    });
    await this.deps.jobs.insert(job);
    await this.deps.jobs.abandon(computer.id, input.now);
    return view(computer, job.id);
  }

  /** Removes this cloud computer's service and disk, then places the same computer again.
   * The typed name must match the name the owner sees. */
  async format(input: {
    userId: string;
    workspaceId: string;
    computerId: string;
    confirmName: string;
    now: Date;
  }): Promise<CloudComputerView> {
    const workspace = await this.#workspace(input.workspaceId, input.userId);
    const computer = (await this.deps.fleet.list(input.userId)).find(
      (item) => item.id === input.computerId && item.deletedAt === null,
    );
    if (!computer) throw new HostJobError(404, "cloud computer not found");
    const expected = computer.displayName.trim() || computer.name;
    if (input.confirmName.trim() !== expected)
      throw new HostJobError(409, "confirmation does not match");
    const open = await this.deps.jobs.findOpenFormat(input.userId, computer.id);
    if (open) return view(computer, open.id);
    const clusterId = await this.deps.cluster.id();
    const job = this.#job({
      clusterId,
      operation: "delete",
      workspace,
      computer,
      ownerId: input.userId,
      idempotencyKey: `cloud-format:${computer.id}:${crypto.randomUUID()}`,
      daemonApiKey: null,
      now: input.now,
    });
    await this.deps.jobs.insert(job);
    await this.deps.jobs.abandon(computer.id, input.now);
    return view(computer, job.id);
  }

  async claim(input: { token: string }): Promise<ClaimedHostJob | undefined> {
    const cluster = await this.deps.cluster.authenticate(input.token);
    if (!cluster) throw new HostJobError(401, "invalid host token");
    const job = await this.deps.jobs.next(cluster.id, cluster.accepting);
    if (!job) return undefined;
    if (job.operation !== "delete" && !job.daemonApiKey) return undefined;
    return {
      jobId: job.id,
      operation: job.operation,
      computerId: job.computerId,
      workspaceId: job.workspaceId,
      workspaceSlug: job.workspaceSlug,
      name: job.name,
      daemonApiKey: job.daemonApiKey,
    };
  }

  async report(input: {
    token: string;
    jobId: string;
    containerId?: string;
    now: Date;
  }): Promise<void> {
    const cluster = await this.deps.cluster.authenticate(input.token);
    if (!cluster) throw new HostJobError(401, "invalid host token");
    const job = await this.deps.jobs.findById(input.jobId);
    if (!job || job.clusterId !== cluster.id) throw new HostJobError(404, "job not found");
    if (job.reportedAt) return;
    if (job.operation === "create") {
      const containerId = requireText(input.containerId ?? "", "invalid container id");
      job.containerId = containerId;
      await this.deps.fleet.markReady(job.computerId);
      await this.#attachLinkedWorkspaces(job, input.now);
    }
    if (job.operation === "delete" && job.idempotencyKey.startsWith("cloud-format:")) {
      await this.deps.fleet.forgetContainer(job.computerId);
      await this.deps.disk?.clear(job.computerId);
      await this.#placeAgain(job, input.now);
    } else if (job.operation === "delete") {
      await this.deps.fleet.markDeleted(job.computerId, input.now);
    }
    job.daemonApiKey = null;
    job.reportedAt = input.now;
    await this.deps.jobs.save(job);
  }

  async #create(
    userId: string,
    workspace: { id: string; slug: string },
    clusterId: string,
    slot: CloudSlot,
    name: string,
    now: Date,
  ): Promise<CloudComputerView> {
    const computer: CloudComputer = {
      id: crypto.randomUUID(),
      ownerId: userId,
      slot,
      homeWorkspaceId: slot === "extra" ? workspace.id : null,
      name,
      displayName: name,
      containerReady: false,
      deletedAt: null,
    };
    await this.deps.fleet.insert(computer);
    const daemonApiKey = await this.deps.keys.issue({
      userId,
      workspaceId: workspace.id,
      computerId: computer.id,
    });
    await this.deps.fleet.link(computer.id, workspace.id, workspace.slug);
    const job = this.#job({
      clusterId,
      operation: "create",
      workspace,
      computer,
      ownerId: userId,
      idempotencyKey: `cloud-${slot}:${computer.id}`,
      daemonApiKey,
      now,
    });
    await this.deps.jobs.insert(job);
    return view(computer, job.id);
  }

  async #attachIfNeeded(
    computer: CloudComputer,
    workspace: { id: string; slug: string },
    userId: string,
    clusterId: string,
    now: Date,
  ): Promise<void> {
    if (!computer.containerReady) return;
    if (await this.deps.fleet.isLinked(computer.id, workspace.id)) return;
    const key = `cloud-attach:${computer.id}:${workspace.id}`;
    if (await this.deps.jobs.findByIdempotency(userId, key)) return;
    const daemonApiKey = await this.deps.keys.issue({
      userId,
      workspaceId: workspace.id,
      computerId: computer.id,
    });
    await this.deps.fleet.link(computer.id, workspace.id, workspace.slug);
    await this.deps.jobs.insert(
      this.#job({
        clusterId,
        operation: "attach",
        workspace,
        computer,
        ownerId: userId,
        idempotencyKey: key,
        daemonApiKey,
        now,
      }),
    );
  }

  async #attachLinkedWorkspaces(job: HostJobRecord, now: Date): Promise<void> {
    const computer = (await this.deps.fleet.list(job.ownerId)).find(
      (item) => item.id === job.computerId,
    );
    if (!computer) return;
    const ready = { ...computer, containerReady: true };
    for (const workspace of await this.deps.fleet.linkedWorkspaces(job.computerId)) {
      if (workspace.id === job.workspaceId) continue;
      await this.#reattach(ready, workspace, job.ownerId, job.clusterId, job.id, now);
    }
  }

  /** Queues an attach for a Workspace that is already linked, after a fresh container exists. */
  async #reattach(
    computer: CloudComputer,
    workspace: { id: string; slug: string },
    userId: string,
    clusterId: string,
    placementId: string,
    now: Date,
  ): Promise<void> {
    const key = `cloud-attach:${computer.id}:${workspace.id}:${placementId}`;
    if (await this.deps.jobs.findByIdempotency(userId, key)) return;
    const daemonApiKey = await this.deps.keys.issue({
      userId,
      workspaceId: workspace.id,
      computerId: computer.id,
    });
    await this.deps.jobs.insert(
      this.#job({
        clusterId,
        operation: "attach",
        workspace,
        computer,
        ownerId: userId,
        idempotencyKey: key,
        daemonApiKey,
        now,
      }),
    );
  }

  async #placeAgain(job: HostJobRecord, now: Date): Promise<void> {
    const computer = (await this.deps.fleet.list(job.ownerId)).find(
      (item) => item.id === job.computerId && item.deletedAt === null,
    );
    if (!computer) return;
    const key = `cloud-format-create:${computer.id}:${job.id}`;
    if (await this.deps.jobs.findByIdempotency(job.ownerId, key)) return;
    const daemonApiKey = await this.deps.keys.issue({
      userId: job.ownerId,
      workspaceId: job.workspaceId,
      computerId: computer.id,
    });
    await this.deps.jobs.insert(
      this.#job({
        clusterId: job.clusterId,
        operation: "create",
        workspace: { id: job.workspaceId, slug: job.workspaceSlug },
        computer,
        ownerId: job.ownerId,
        idempotencyKey: key,
        daemonApiKey,
        now,
      }),
    );
  }

  #job(input: {
    clusterId: string;
    operation: HostJobOperation;
    workspace: { id: string; slug: string };
    computer: CloudComputer;
    ownerId: string;
    idempotencyKey: string;
    daemonApiKey: string | null;
    now: Date;
  }): HostJobRecord {
    return {
      id: crypto.randomUUID(),
      clusterId: input.clusterId,
      operation: input.operation,
      workspaceId: input.workspace.id,
      workspaceSlug: input.workspace.slug,
      computerId: input.computer.id,
      ownerId: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      name: input.computer.name,
      daemonApiKey: input.daemonApiKey,
      containerId: null,
      createdAt: input.now,
      reportedAt: null,
    };
  }

  async #workspace(workspaceId: string, userId: string): Promise<{ id: string; slug: string }> {
    const workspace = await this.deps.workspaces.findMember(workspaceId, userId);
    if (!workspace) throw new HostJobError(403, "workspace access denied");
    return workspace;
  }
}

export function compareJobs(left: HostJobRecord, right: HostJobRecord): number {
  const operation = OPERATION_ORDER[left.operation] - OPERATION_ORDER[right.operation];
  if (operation !== 0) return operation;
  return left.createdAt.getTime() - right.createdAt.getTime();
}

function active(computers: CloudComputer[]): CloudComputer[] {
  return computers.filter((computer) => computer.deletedAt === null);
}

function view(computer: CloudComputer, jobId: string | null): CloudComputerView {
  return {
    computerId: computer.id,
    slot: computer.slot,
    name: computer.name,
    containerReady: computer.containerReady,
    jobId,
  };
}

function requireText(value: string, message: string): string {
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) throw new HostJobError(422, message);
  return text;
}
