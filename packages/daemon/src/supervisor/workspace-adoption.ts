import type { DaemonHandshakeResponse, ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import type { NativeProcessIdentity, WorkspaceInstance } from "./workspace-instance";
import type { ObservedBinding } from "./workspace-runtime-view";

/** How long a snapshot waits for a live Workspace it has not adopted to answer its handshake. */
const ADOPTION_HANDSHAKE_MS = 1_000;

/** One Workspace daemon the Coordinator adopted: its OS unit, handshake identity, and invocation. */
export type AdoptedWorkspace = {
  instance: WorkspaceInstance;
  identity: ManagedRuntimeIdentity;
  osInstanceId: string;
};

export type WorkspaceAdoptionPorts = {
  instance(workspaceId: string): WorkspaceInstance;
  /** The Workspace daemon's own answer over its local socket. */
  handshake(workspaceId: string, timeoutMs?: number): Promise<DaemonHandshakeResponse>;
};

/**
 * The Coordinator's record of the Workspace daemons it adopted. An entry is dropped only when the
 * Workspace is stopped or its start fails; a read that finds the OS unit gone leaves it in place,
 * where it simply no longer matches the live invocation.
 */
export class WorkspaceAdoptions {
  #adopted = new Map<string, AdoptedWorkspace>();

  constructor(private readonly ports: WorkspaceAdoptionPorts) {}

  get(workspaceId: string): AdoptedWorkspace | undefined {
    return this.#adopted.get(workspaceId);
  }

  forget(workspaceId: string): void {
    this.#adopted.delete(workspaceId);
  }

  /** Records `observed` as this Workspace's adopted daemon; its handshake identity is filled in
   * once the handshake holds. */
  track(
    binding: { workspaceId: string; computerId: string },
    instance: WorkspaceInstance,
    observed: NativeProcessIdentity,
    handshakeIdentity = { instanceId: "", version: "" },
  ): ManagedRuntimeIdentity {
    const identity: ManagedRuntimeIdentity = {
      workspaceId: binding.workspaceId,
      computerId: binding.computerId,
      enabled: true,
      processId: observed.mainPid,
      ...handshakeIdentity,
    };
    this.#adopted.set(binding.workspaceId, {
      instance,
      identity,
      osInstanceId: observed.invocationId,
    });
    return identity;
  }

  /**
   * One readiness check of a live OS invocation: its daemon answers the handshake as that
   * invocation's main process at this build's version, and the OS still runs that same invocation
   * afterwards. A fresh start polls it; `adoptLive` asks it once. Returns the daemon's handshake
   * identity when it holds, else null.
   */
  async handshake(
    workspaceId: string,
    instance: WorkspaceInstance,
    observed: NativeProcessIdentity,
    timeoutMs?: number,
  ): Promise<{ instanceId: string; version: string } | null> {
    const reported = await this.ports.handshake(workspaceId, timeoutMs).catch(() => null);
    if (reported?.processId !== observed.mainPid || reported.version !== COFORGE_DAEMON_VERSION)
      return null;
    const current = await instance.identity();
    if (!current?.active || current.invocationId !== observed.invocationId)
      throw new Error("Workspace OS identity changed during handshake");
    return { instanceId: reported.daemonId, version: COFORGE_DAEMON_VERSION };
  }

  /** Adopts a live OS invocation this Coordinator did not start or no longer tracks (launchd
   * relaunched the Workspace, or it outlived the Coordinator's record of it) once it passes the
   * same handshake as a fresh start, so the snapshot reports what the OS really runs. */
  async adoptLive(binding: ObservedBinding): Promise<void> {
    // A start under way adopts its own invocation.
    if (!binding.instanceId || binding.inFlight) return;
    if (this.#adopted.get(binding.workspaceId)?.osInstanceId === binding.instanceId) return;
    const instance = this.ports.instance(binding.workspaceId);
    // A failed read leaves this Workspace unadopted until the next snapshot; it never fails one.
    const observed = await instance.identity().catch(() => null);
    if (!observed?.active) return;
    const reported = await this.handshake(
      binding.workspaceId,
      instance,
      observed,
      ADOPTION_HANDSHAKE_MS,
    ).catch(() => null);
    if (reported) this.track(binding, instance, observed, reported);
  }
}
