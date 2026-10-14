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

export type ComputerSetupOptions = {
  config: Pick<ComputerConfig, "loadCurrentProfile"> &
    Partial<Pick<ComputerConfig, "saveCurrentProfile">> &
    Required<Pick<ComputerConfig, "saveRegistration" | "discardRegistration">> &
    Partial<Pick<ComputerConfig, "loadRegistration">>;
  credentials: SetupCredentialStore;
  authenticate?: SetupAuthenticator;
  workspaceLookup: WorkspaceLookup;
  registrationFactory: (serverUrl: string, credential: Credential) => SetupRegistration;
  launcher: DaemonLauncher | ((serverUrl: string) => DaemonLauncher);
  metadataProvider: ComputerMetadataProvider;
  idempotencyKeyProvider: RegistrationIdempotencyKeyProvider;
  workspaceRoot: string;
  serverUrl: string;
};

export class ComputerSetup {
  constructor(private readonly options: ComputerSetupOptions) {}

  async run(input: { workspaceSlug?: string; json?: boolean }): Promise<SetupResult> {
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
    let credential: Credential | null = await setupStep(
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
    if (!credential)
      throw setupError("SETUP_NOT_LOGGED_IN", "No login credential exists for the current server.");
    if (!profile && this.options.config.saveCurrentProfile) {
      await this.options.config.saveCurrentProfile({ serverUrl });
    }

    if (!input.workspaceSlug) {
      throw setupError(
        "SETUP_WORKSPACE_REQUIRED",
        "Setup requires a target Workspace: pass `--workspace <slug>`, or set COFORGE_SETUP_INTENT for automated setup.",
      );
    }
    let workspace: AccessibleWorkspace;
    try {
      try {
        workspace = await this.options.workspaceLookup.getBySlug(
          serverUrl,
          credential,
          input.workspaceSlug,
        );
      } catch (error) {
        if (
          !(error instanceof CliError) ||
          error.code !== "AUTH_LOGIN_EXPIRED" ||
          !this.options.authenticate
        )
          throw error;
        credential = await this.options.authenticate.authenticate(serverUrl, input.json ?? false);
        workspace = await this.options.workspaceLookup.getBySlug(
          serverUrl,
          credential,
          input.workspaceSlug,
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
              input.workspaceSlug ?? workspace.slug,
            ),
            workspaceSlug: workspace.slug,
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
              `${input.workspaceSlug ?? workspace.slug}:${metadata.machineId}`,
            ),
          }),
      );
      workspace = { id: response.workspaceId, slug: workspace.slug, name: workspace.name };
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
          }),
      );
      daemonStillStarting = started?.lifecycleUnderWay === true;
      const registration = registeredRegistration;
      configPath = await setupStep(
        "SETUP_CONFIG_WRITE_FAILED",
        "Could not save the Workspace configuration.",
        () => this.options.config.saveRegistration(registration),
      );
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw setupError(
        "SETUP_COMPUTER_REGISTER_FAILED",
        "Computer registration could not be completed.",
        "computer-registration",
        error,
      );
    }

    return { workspace, configPath, ...(daemonStillStarting ? { daemonStillStarting: true } : {}) };
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
