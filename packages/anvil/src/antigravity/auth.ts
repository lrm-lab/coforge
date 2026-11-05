import { RequestError } from "@agentclientprotocol/sdk";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { acpBounded, acpProcess } from "#src/acp/connection";
import type { ProcessTreeSpawner } from "#src/process-tree";
import {
  type RuntimeAuthAdapter,
  type RuntimeAuthLoginInteraction,
  type RuntimeAuthLoginResult,
  type RuntimeAuthLogoutResult,
  type RuntimeAuthStatus,
} from "#src/contract";
import { ANTIGRAVITY_ACP_PROFILE } from "./acp-session";

/** `session/new`'s refusal before a user signs in to this server's own account. */
export const ANTIGRAVITY_AUTH_REQUIRED_CODE = -32000;
/** `authenticate`'s answer when the browser sign-in is cancelled or its window closes. */
const ANTIGRAVITY_AUTH_CANCELLED_CODE = -32800;
/** `authenticate` may wait for a browser sign-in: five minutes before the process is dropped. */
const ANTIGRAVITY_AUTH_TIMEOUT_MS = 300_000;
/** `logout`/`session/new` probes get the ordinary short bound. */
const ANTIGRAVITY_AUTH_PROBE_TIMEOUT_MS = 30_000;

export type AntigravityAuthMethod = "oauth-personal" | "oauth-business";
const SUPPORTED_METHODS: readonly AntigravityAuthMethod[] = ["oauth-personal", "oauth-business"];

const loggedOut: RuntimeAuthStatus = {
  provider: RUNTIME_PROVIDER.ANTIGRAVITY,
  state: "logged_out",
};

export interface AntigravityAuthHost {
  /** The executable the host resolved for this runtime — never `agy` from PATH. */
  command: readonly string[];
  /** The launch environment for the short-lived `agy acp` auth process. */
  environment: Readonly<Record<string, string>>;
  /** Process ownership for the auth subprocess. */
  processTreeSpawner: ProcessTreeSpawner;
  /** Identity this connection announces to the server. */
  clientInfo: Readonly<{ name: string; version: string }>;
  /** Whether a browser can open on this Computer — a desktop session, not a headless remote. */
  readonly canOpenBrowser: boolean;
  /** The daemon's own state directory — the cwd a status probe's `session/new` runs under. */
  readonly stateDirectory: string;
  /** The only form of an account's label that leaves a status read. */
  maskAccountLabel(value: string): string | undefined;
}

/** One `agy acp` transport for an auth exchange — spawned for the call, dropped afterward. */
export class AntigravityRuntimeAuthAdapter implements RuntimeAuthAdapter {
  readonly provider = RUNTIME_PROVIDER.ANTIGRAVITY;
  /** A status read costs a fresh `session/new` + `session/close` — every inventory report, page
   * open, login and logout probes it, so a 60-second cache keeps the server out of the path. */
  #statusCache: { at: number; status: RuntimeAuthStatus } | undefined;
  constructor(private readonly host: AntigravityAuthHost) {}

  async readStatus(
    options: { workingDirectory: string; timeoutMs?: number },
    forceRefresh = false,
  ): Promise<RuntimeAuthStatus> {
    if (!forceRefresh && this.#statusCache && Date.now() - this.#statusCache.at < 60_000)
      return this.#statusCache.status;
    const status = await this.#withProcess(options.workingDirectory, (transport) =>
      this.#loggedIn(transport),
    );
    this.#statusCache = { at: Date.now(), status };
    return status;
  }

  async startLogin(
    options: {
      workingDirectory: string;
      timeoutMs?: number;
      antigravityMethodId?: AntigravityAuthMethod;
    },
    interaction: RuntimeAuthLoginInteraction,
  ): Promise<RuntimeAuthLoginResult> {
    if (!this.host.canOpenBrowser)
      return {
        status: "failed",
        reason: "interaction_failed",
        detail: "antigravity_no_desktop",
      };
    const methodId = options.antigravityMethodId ?? "oauth-personal";
    if (!SUPPORTED_METHODS.includes(methodId))
      return {
        status: "unsupported",
        reason: "unsupported_installation",
        detail: `Antigravity login supports ${SUPPORTED_METHODS.join(" and ")}.`,
      };
    const timeoutMs = options.timeoutMs ?? ANTIGRAVITY_AUTH_TIMEOUT_MS;
    interaction.onEvent({ kind: "info", message: "A browser opens on this Computer." });
    const transport = acpProcess(ANTIGRAVITY_ACP_PROFILE, {
      command: this.host.command,
      cwd: options.workingDirectory,
      environment: this.host.environment,
      clientInfo: this.host.clientInfo,
      processTreeSpawner: this.host.processTreeSpawner,
    });
    const controller = new AbortController();
    const dispose = () => void transport.process.dispose();
    controller.signal.addEventListener("abort", dispose, { once: true });
    if (interaction.signal) {
      if (interaction.signal.aborted) dispose();
      else interaction.signal.addEventListener("abort", dispose, { once: true });
    }
    try {
      await acpBounded(
        transport.connection.agent.request("authenticate", { methodId }),
        timeoutMs,
        "agy acp authenticate timed out",
      );
      const authStatus = await this.readStatus(
        { workingDirectory: options.workingDirectory },
        true,
      );
      if (authStatus.state === "logged_in") return { status: "logged_in", authStatus };
      return {
        status: "failed",
        reason: "rejected",
        detail: "The sign-in did not complete in the browser.",
      };
    } catch (error) {
      if (error instanceof RequestError && error.code === ANTIGRAVITY_AUTH_CANCELLED_CODE)
        return { status: "cancelled" };
      // Either abort path — the daemon's signal or an explicit `cancel` — ends as cancelled,
      // including the process-closed error a disposed transport surfaces.
      if (controller.signal.aborted || interaction.signal?.aborted) return { status: "cancelled" };
      if (error instanceof Error && /timed out/i.test(error.message))
        return {
          status: "failed",
          reason: "timed_out",
          detail: "The browser sign-in did not complete in time.",
        };
      throw error;
    } finally {
      await transport.process.dispose();
    }
  }

  async submitCode(): Promise<void> {
    // `authenticate` is a browser flow — no code ever rides back to paste.
  }

  async cancel(): Promise<void> {
    // The daemon's abort signal is the cancel path — there is no provider-side cancel RPC.
  }

  async logout(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthLogoutResult> {
    const timeoutMs = options.timeoutMs ?? ANTIGRAVITY_AUTH_PROBE_TIMEOUT_MS;
    const transport = acpProcess(ANTIGRAVITY_ACP_PROFILE, {
      command: this.host.command,
      cwd: options.workingDirectory,
      environment: this.host.environment,
      clientInfo: this.host.clientInfo,
      processTreeSpawner: this.host.processTreeSpawner,
    });
    try {
      await acpBounded(
        transport.connection.agent.request("logout", {}),
        timeoutMs,
        "agy acp logout timed out",
      );
      const authStatus = await this.#loggedIn(transport).catch(() => loggedOut);
      if (authStatus.state === "logged_in") return { status: "failed", reason: "still_logged_in" };
      return { status: "logged_out", authStatus };
    } catch (error) {
      return {
        status: "failed",
        reason:
          error instanceof Error && /timed out/i.test(error.message)
            ? "timed_out"
            : "process_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await transport.process.dispose();
    }
  }

  /** Whether the server takes `session/new` — `-32000` means signed out, anything else a real
   * result or an unrelated failure (which this read surfaces as `unknown`, not a crash). The
   * probe's session is closed behind it: a status read must never leave a live conversation. */
  async #loggedIn(transport: ReturnType<typeof acpProcess>): Promise<RuntimeAuthStatus> {
    let probed: string | undefined;
    try {
      const state = await acpBounded(
        transport.connection.agent.request("session/new", {
          cwd: this.host.stateDirectory,
          mcpServers: [],
        }),
        ANTIGRAVITY_AUTH_PROBE_TIMEOUT_MS,
        "agy acp session/new timed out",
      );
      probed =
        typeof (state as { sessionId?: unknown })?.sessionId === "string"
          ? (state as { sessionId: string }).sessionId
          : undefined;
      // `session/new` cannot say which account signed in — `authMethods` are labels only.
      return { provider: RUNTIME_PROVIDER.ANTIGRAVITY, state: "logged_in" };
    } catch (error) {
      if (error instanceof RequestError && error.code === ANTIGRAVITY_AUTH_REQUIRED_CODE)
        return loggedOut;
      return { provider: RUNTIME_PROVIDER.ANTIGRAVITY, state: "unknown" };
    } finally {
      if (probed) {
        await transport.connection.agent
          .request("session/close", { sessionId: probed })
          .catch(() => undefined);
      }
    }
  }

  async #withProcess<T>(
    cwd: string,
    work: (transport: ReturnType<typeof acpProcess>) => Promise<T>,
  ): Promise<T> {
    const transport = acpProcess(ANTIGRAVITY_ACP_PROFILE, {
      command: this.host.command,
      cwd,
      environment: this.host.environment,
      clientInfo: this.host.clientInfo,
      processTreeSpawner: this.host.processTreeSpawner,
    });
    try {
      return await work(transport);
    } finally {
      await transport.process.dispose();
    }
  }
}
