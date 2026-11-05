import type { AccessibleWorkspace, Credential } from "#src/login";
import { loadBuildProfile, type ComputerConfig } from "#src/local-config";
import { CliError, setupError, type SetupErrorCode } from "#src/errors";
import type {
  ComputerRegisterRequest,
  ComputerRegistrationClient,
} from "@lrm/coforge-sdk/internal";
import type { DaemonLauncher } from "@lrm/coforge-daemon";
import type { WorkspaceLookup } from "#src/workspace/lookup";

export type ComputerPlatformName = "darwin" | "linux" | "win32";

export type SetupResult = {
  workspace: AccessibleWorkspace;
  configPath: string;
  serverUrl?: string;
  /** The machine was already attached and its stored key still worked: nothing was registered. */
  resumed?: true;
  /** The Daemon took the configuration, but the Workspace was still starting when it answered. */
  daemonStillStarting?: true;
};

export interface ComputerMetadataProvider {
  get(): Promise<{
    name: string;
    displayName: string;
    platform: ComputerPlatformName;
    osVersion: string;
    computerVersion: string;
    machineId: string;
  }>;
}

export interface RegistrationIdempotencyKeyProvider {
  create(serverUrl: string, value: string): string;
}

export interface SetupCredentialStore {
  load(serverUrl: string): Promise<Credential | null>;
}

export interface SetupRegistration {
  register(request: ComputerRegisterRequest): ReturnType<ComputerRegistrationClient["register"]>;
}

export interface SetupAuthenticator {
  authenticate(serverUrl: string, json: boolean): Promise<Credential>;
}

/** What a re-run of setup/attach on an already-attached Workspace needs: the Daemon's stored
 * key and a live check of it (task #417; Raft's `resumeExistingAttachment`). */
export interface SetupResumePort {
  storedKey(workspaceId: string, computerId: string): Promise<string | null>;
  self(
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ state: "live" | "revoked" | "forbidden" | "unsupported" | "unreachable" }>;
}

export type ComputerSetupOptions = {
  /** Without it, an existing attachment is not resumed. */
  resume?: SetupResumePort;
  config: Pick<ComputerConfig, "loadCurrentProfile"> &
    Partial<Pick<ComputerConfig, "saveCurrentProfile">> &
    Required<Pick<ComputerConfig, "saveRegistration" | "discardRegistration">> &
    Partial<Pick<ComputerConfig, "loadRegistration">>;
  credentials: SetupCredentialStore;
  authenticate?: SetupAuthenticator;
  workspaceLookup: WorkspaceLookup;
  /** `attach --one-shot`: the attach-session credential (the `attach_token` `computer:register`
   * consumes) instead of the OAuth login (task #417). */
  oneShotAttach?: (
    serverUrl: string,
    options?: {
      onStage?: (stage: string, detail?: Record<string, string>) => void;
    },
  ) => Promise<Credential & { workspaceId?: string; workspaceSlug?: string }>;
  registrationFactory: (serverUrl: string, credential: Credential) => SetupRegistration;
  launcher: DaemonLauncher | ((serverUrl: string) => DaemonLauncher);
  metadataProvider: ComputerMetadataProvider;
  idempotencyKeyProvider: RegistrationIdempotencyKeyProvider;
  workspaceRoot: string;
  serverUrl: string;
};

export class ComputerSetup {
  constructor(private readonly options: ComputerSetupOptions) {}

  async run(input: {
    workspaceSlug?: string;
    json?: boolean;
    /** `attach --one-shot`: report the machine, poll the approval page, and register with the
     * one-shot token it hands back rather than a stored OAuth login (task #417). */
    oneShot?: boolean;
    /** `--json` stage evidence (task #417): `started`/`polling`/`approved` reach `oneShotAttach`;
     * `registered`/`saved` are emitted here with their paths. Undefined outside `--json`. */
    onStage?: (stage: string, detail?: Record<string, string>) => void;
  }): Promise<SetupResult> {
    const serverUrl = this.options.serverUrl;
    const profile = await loadBuildProfile(this.options.config, serverUrl, "setup");
    const launcher =
      typeof this.options.launcher === "function"
        ? this.options.launcher(serverUrl)
        : this.options.launcher;
    await setupStep(
      "SETUP_BUILD_ENVIRONMENT_MISMATCH",
      "The existing Daemon belongs to another server environment.",
      async () => launcher.preflight?.(),
    );
    // Re-running setup on an attached Workspace resumes it; it never creates a second
    // attachment. Replacing one takes `detach` first (task #417).
    if (input.workspaceSlug) {
      const resumed = await this.resumeAttached(input.workspaceSlug, serverUrl, launcher, input);
      if (resumed) return resumed;
    }
    let credential: Credential | null;
    if (input.oneShot) {
      if (!this.options.oneShotAttach)
        throw setupError(
          "SETUP_ONE_SHOT_UNSUPPORTED",
          "The one-shot attach is not wired into this build.",
        );
      credential = await setupStep(
        "SETUP_ATTACH_FAILED",
        "The one-shot attach could not be completed.",
        () => this.options.oneShotAttach!(serverUrl, { onStage: input.onStage }),
      );
    } else {
      credential = await setupStep(
        "SETUP_CREDENTIALS_FAILED",
        "Could not read the local login credential.",
        () => this.options.credentials.load(serverUrl),
      );
      const authenticate = this.options.authenticate;
      if (!credential && authenticate) {
        credential = await setupStep(
          "SETUP_OAUTH_FAILED",
          "OAuth login could not be completed.",
          () => authenticate.authenticate(serverUrl, input.json ?? false),
        );
      }
    }
    if (input.oneShot && !input.workspaceSlug) {
      // The token's bound Workspace is only known after the poll; if this machine is already
      // attached there, resume — the token is not consumed (task #417).
      const bound = credential as Credential & {
        workspaceSlug?: string;
        workspaceId?: string;
      };
      const selector = bound.workspaceId ?? bound.workspaceSlug;
      if (selector) {
        const resumed = await this.resumeAttached(selector, serverUrl, launcher, input);
        if (resumed) return resumed;
      }
    }
    if (!credential)
      throw setupError("SETUP_NOT_LOGGED_IN", "No login credential exists for the current server.");
    if (!profile && this.options.config.saveCurrentProfile) {
      await this.options.config.saveCurrentProfile({ serverUrl });
    }

    if (!input.workspaceSlug && !input.oneShot) {
      throw setupError(
        "SETUP_WORKSPACE_REQUIRED",
        "Setup requires a target Workspace: pass `--workspace <slug>`, or set COFORGE_SETUP_INTENT for automated setup.",
      );
    }
    let workspace: AccessibleWorkspace | undefined;
    try {
      try {
        workspace = input.oneShot
          ? undefined
          : await this.options.workspaceLookup.getBySlug(
              serverUrl,
              credential,
              input.workspaceSlug!,
            );
      } catch (error) {
        if (
          !(error instanceof CliError) ||
          error.code !== "AUTH_LOGIN_EXPIRED" ||
          !this.options.authenticate
        )
          throw error;
        credential = await this.options.authenticate.authenticate(serverUrl, input.json ?? false);
        workspace = input.oneShot
          ? undefined
          : await this.options.workspaceLookup.getBySlug(
              serverUrl,
              credential,
              input.workspaceSlug!,
            );
      }
    } catch (error) {
      if (error instanceof CliError && error.code === "AUTH_WORKSPACE_GET_FAILED") {
        throw setupError(
          "SETUP_WORKSPACE_NOT_FOUND",
          `Workspace '${input.workspaceSlug}' was not found or is not accessible.`,
        );
      }
      if (error instanceof CliError) throw error;
      throw setupError(
        "SETUP_WORKSPACE_LOOKUP_FAILED",
        "Could not look up the requested Workspace.",
      );
    }

    let configPath: string;
    let daemonStillStarting = false;
    let registeredRegistration:
      | Parameters<NonNullable<ComputerConfig["discardRegistration"]>>[0]
      | undefined;
    try {
      const metadata = await this.options.metadataProvider.get();
      const registered = credential;
      const response = await setupStep(
        "SETUP_COMPUTER_REGISTER_FAILED",
        "Computer registration could not be completed.",
        () =>
          this.options.registrationFactory(serverUrl, registered).register({
            protocolMajor: 1,
            requestId: this.options.idempotencyKeyProvider.create(
              serverUrl,
              input.workspaceSlug ?? workspace?.slug ?? "",
            ),
            workspaceSlug: workspace?.slug ?? "",
            name: metadata.name,
            displayName: metadata.displayName,
            machineId: metadata.machineId,
            platform: metadata.platform,
            osVersion: metadata.osVersion,
            computerVersion: metadata.computerVersion,
            // Runtime inventory is discovered and published by the Daemon after
            // it owns the Workspace connection. Computer registration contains
            // machine identity only; it must not snapshot provider installs.
            registrationIdempotencyKey: this.options.idempotencyKeyProvider.create(
              serverUrl,
              `${input.workspaceSlug ?? workspace?.slug ?? ""}:${metadata.machineId}`,
            ),
          }),
      );
      // The one-shot path resolves no workspace of its own — the token's bound one, which the
      // response carries, is where this machine landed (task #417).
      workspace = {
        id: response.workspaceId,
        slug: response.workspaceSlug ?? workspace?.slug ?? "",
        name: workspace?.name ?? response.workspaceSlug ?? "",
      };
      registeredRegistration = {
        id: response.workspaceId,
        slug: workspace.slug,
        computerId: response.computerId,
      };
      // Start first: the Daemon must accept its credential before local
      // configuration advertises this registration as usable.
      // The Coordinator answers by its deadline: the configuration is taken even when the
      // Workspace is still starting, so the registration below is still saved.
      const started = await setupStep(
        "SETUP_DAEMON_START_FAILED",
        "The Daemon could not be started.",
        () =>
          launcher.ensureStarted({
            workspaceId: response.workspaceId,
            computerId: response.computerId,
            workspaceRoot: this.options.workspaceRoot,
            daemonApiKey: response.daemonApiKey,
            serverHttpUrl: serverUrl,
            // A login-style setup retires the login it used; a one-shot attach leaves no login
            // to retire, so this flag goes unset there (task #417).
            loginSetup: !input.oneShot,
          }),
      );
      daemonStillStarting = started?.lifecycleUnderWay === true;
      const registration = registeredRegistration;
      configPath = await setupStep(
        "SETUP_CONFIG_WRITE_FAILED",
        "Could not save the Workspace configuration.",
        () => this.options.config.saveRegistration(registration),
      );
      input.onStage?.("registered", {
        computerId: registeredRegistration.computerId ?? "",
        workspaceSlug: workspace?.slug ?? "",
      });
      input.onStage?.("saved", { configPath });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw setupError(
        "SETUP_COMPUTER_REGISTER_FAILED",
        "Computer registration could not be completed.",
        "computer-registration",
        error,
      );
    }

    return {
      workspace,
      configPath,
      serverUrl,
      ...(daemonStillStarting ? { daemonStillStarting: true } : {}),
    };
  }

  /** The existing attachment of `selector` (a slug or id), resumed when its stored key is live;
   * `undefined` when this machine holds none. A dead or unverifiable key is an error, never a
   * fresh attachment. */
  private async resumeAttached(
    selector: string,
    serverUrl: string,
    launcher: DaemonLauncher,
    input: {
      onStage?: (stage: string, detail?: Record<string, string>) => void;
    },
  ): Promise<SetupResult | undefined> {
    const { config, resume } = this.options;
    if (!resume || !config.loadRegistration) return undefined;
    const registration = await setupStep(
      "SETUP_ALREADY_ATTACHED_READ_FAILED",
      "The local Workspace registrations could not be read.",
      () => config.loadRegistration!(selector),
    );
    if (!registration) return undefined;
    const key = registration.computerId
      ? await setupStep(
          "SETUP_ALREADY_ATTACHED_READ_FAILED",
          "The stored credential of this computer could not be read.",
          () => resume.storedKey(registration.id, registration.computerId!),
        )
      : null;
    if (!key)
      throw setupError(
        "SETUP_ALREADY_ATTACHED_INVALID",
        `This computer is attached to '${registration.slug}' but holds no usable credential.`,
      );
    // A key the Daemon has not yet swapped for its own `sk_computer` is still the attach's
    // `dk_`: `/self` answers a live one 403 (valid, but not a linked Computer key) and a dead
    // one 401. A live `dk_` resumes and the Daemon's key migration swaps it; an `sk_` that is
    // forbidden is gone.
    const checked = await resume.self(key, AbortSignal.timeout(15_000));
    const state =
      checked.state === "forbidden" ? (key.startsWith("dk_") ? "live" : "revoked") : checked.state;
    if (state === "unsupported")
      throw setupError(
        "SETUP_ALREADY_ATTACHED_UNSUPPORTED",
        `The server cannot verify this computer's attachment to '${registration.slug}'.`,
      );
    if (state === "revoked")
      throw setupError(
        "SETUP_ALREADY_ATTACHED_INVALID",
        `This computer's credential for '${registration.slug}' is no longer valid.`,
      );
    if (state === "unreachable")
      throw setupError(
        "SETUP_ALREADY_ATTACHED_UNREACHABLE",
        `Could not verify this computer's existing attachment to '${registration.slug}'.`,
      );
    const started = await setupStep(
      "SETUP_DAEMON_START_FAILED",
      "The Daemon could not be started.",
      () =>
        launcher.ensureStarted({
          workspaceId: registration.id,
          computerId: registration.computerId!,
          workspaceRoot: this.options.workspaceRoot,
          daemonApiKey: key,
          serverHttpUrl: serverUrl,
          loginSetup: false,
        }),
    );
    const configPath = await setupStep(
      "SETUP_CONFIG_WRITE_FAILED",
      "Could not save the Workspace configuration.",
      () => config.saveRegistration(registration),
    );
    input.onStage?.("resumed", { workspaceSlug: registration.slug });
    return {
      workspace: {
        id: registration.id,
        slug: registration.slug,
        name: registration.slug,
      },
      configPath,
      serverUrl,
      resumed: true,
      ...(started?.lifecycleUnderWay === true ? { daemonStillStarting: true as const } : {}),
    };
  }
}

/**
 * Runs one setup step, passing a `CliError` it throws through unchanged and reporting any other
 * failure as the step's own setup error, so a user sees which step failed rather than a raw
 * exception.
 */
async function setupStep<T>(
  code: SetupErrorCode,
  message: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw setupError(code, message);
  }
}
