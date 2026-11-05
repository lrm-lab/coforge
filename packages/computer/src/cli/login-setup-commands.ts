// The login and setup command wiring: credentials, config, and the setup use case.

import { homedir } from "os";
import { join } from "path";
import { detectOperatingSystem, resolveComputerInstallDirectory } from "@lrm/coforge-daemon";
import { OAuthDeviceClient } from "#src/oauth-device-client";
import { ComputerLogin } from "#src/login";
import { loginError, setupError } from "#src/errors";
import { FileCredentialStore } from "#src/credential-store";
import { resolveComputerStateDirectory } from "#src/paths";
import { COFORGE_SERVER_URL } from "#src/release-channel";
import { FileComputerConfig, loadBuildProfile } from "#src/local-config";
import {
  createComputerSelfClient,
  FileDaemonCredentialStore,
  workspaceStateDirectory,
} from "@lrm/coforge-daemon";
import { ComputerSetup, type SetupResumePort } from "#src/setup/computer-setup";
import { oneShotAttach } from "#src/setup/one-shot-attach";
import { hostname } from "node:os";
import { currentComputerNames, currentComputerPlatform } from "#src/platform";
import { FileMachineIdFallback, resolveMachineId } from "#src/machine-id";
import { HttpComputerRegisterTransport, HttpWorkspaceRpcTransport } from "#src/cloud-rpc-transport";
import { ComputerRegistrationClient } from "@lrm/coforge-sdk/internal";
import { createDaemonLauncher } from "#src/daemon-service/daemon-host";
import { createWorkspaceLookup } from "#src/workspace/lookup";
import { registrationIdempotencyKey } from "#src/registration/idempotency-key";
import { writeSetupResult } from "./setup-output";
import { COFORGE_COMPUTER_VERSION as VERSION } from "#src/version";
import type { LoginCommand, SetupCommand } from "#src/cli";

export function createLoginCommand(
  io: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  },
  config: FileComputerConfig,
): LoginCommand {
  const login = new ComputerLogin({
    client: new OAuthDeviceClient({
      clientId: "coforge-computer",
      scope: "openid offline_access",
    }),
    store: new FileCredentialStore(),
    config,
    writeLine: io.stdout,
    writeProgressLine: io.stderr,
    sleep: Bun.sleep,
  });
  return {
    async run(serverUrl, options) {
      // The profile is local: a build that belongs to the other environment is refused here,
      // before the daemon preflight could fail for a reason of its own and hide that answer.
      await loadBuildProfile(config, serverUrl, "login");
      const platform = currentComputerPlatform();
      const stateDirectory = resolveComputerStateDirectory({
        platform: platform.os,
        homeDirectory: homedir(),
        environment: process.env,
      });
      const installDirectory = resolveComputerInstallDirectory({
        platform: platform.os,
        homeDirectory: homedir(),
      });
      try {
        await createDaemonLauncher(
          platform.os,
          installDirectory,
          stateDirectory,
          serverUrl,
        ).preflight?.();
      } catch {
        throw loginError(
          "AUTH_DAEMON_PREFLIGHT_FAILED",
          "Could not verify the local Daemon environment. Login was not started.",
        );
      }
      await login.run({ serverUrl, json: options.json });
    },
  };
}

/** `attach --json` stage evidence (task #417): one JSON line per stage on `stderr`, so `stdout`
 * stays the single result document. Outside `--json` there is no stage output at all. */
export function attachStageEmitter(
  io: { stderr: (line: string) => void },
  json: boolean | undefined,
): ((stage: string, detail?: Record<string, string>) => void) | undefined {
  if (!json) return undefined;
  return (stage, detail) => io.stderr(JSON.stringify({ stage, ...detail }));
}

/** The resume preflight's ports: a Workspace's own `sk_computer` lives under that Workspace's
 * state directory, which is where the Daemon reads it too (task #417). */
export function createResumePort(stateDirectory: string, serverUrl: string): SetupResumePort {
  return {
    storedKey: (workspaceId, computerId) =>
      new FileDaemonCredentialStore(workspaceStateDirectory(stateDirectory, workspaceId)).load(
        workspaceId,
        computerId,
      ),
    self: (apiKey, signal) => createComputerSelfClient(serverUrl).self(apiKey, signal),
  };
}

export function createSetupCommand(
  io: { stdout: (line: string) => void; stderr: (line: string) => void },
  config: FileComputerConfig,
  client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
  }),
): SetupCommand {
  const credentials = new FileCredentialStore();
  const platform = currentComputerPlatform();
  const stateDirectory = resolveComputerStateDirectory({
    platform: platform.os,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const installDirectory = resolveComputerInstallDirectory({
    platform: platform.os,
    homeDirectory: homedir(),
  });
  const setup = new ComputerSetup({
    config,
    workspaceRoot: join(stateDirectory, "workspaces"),
    credentials,
    metadataProvider: {
      async get() {
        const computerNames = currentComputerNames({ platform: platform.os });
        return {
          ...computerNames,
          platform: platform.os,
          osVersion: (await detectOperatingSystem({ platform: platform.os })).osVersion,
          computerVersion: VERSION,
          machineId: await resolveMachineId({
            platform: platform.os,
            fallback: new FileMachineIdFallback(join(stateDirectory, "machine-id")),
          }),
        };
      },
    },
    idempotencyKeyProvider: { create: registrationIdempotencyKey },
    resume: createResumePort(stateDirectory, COFORGE_SERVER_URL),
    authenticate: {
      async authenticate(serverUrl, json) {
        const login = new ComputerLogin({
          client,
          store: credentials,
          config,
          writeLine: io.stdout,
          writeProgressLine: io.stderr,
          suppressFinalResult: true,
          sleep: Bun.sleep,
        });
        await login.run({ serverUrl, json });
        const credential = await credentials.load(serverUrl);
        if (!credential)
          throw setupError(
            "SETUP_NOT_LOGGED_IN",
            "Device authorization did not produce credentials.",
          );
        return credential;
      },
    },
    workspaceLookup: createWorkspaceLookup(new HttpWorkspaceRpcTransport()),
    registrationFactory: (serverUrl, credential) => ({
      register: (request) =>
        new ComputerRegistrationClient(
          new HttpComputerRegisterTransport(serverUrl, credential.accessToken),
        ).register(request),
    }),
    launcher: (serverUrl) =>
      createDaemonLauncher(platform.os, installDirectory, stateDirectory, serverUrl),
    oneShotAttach: (serverUrl, options) =>
      oneShotAttach(
        {
          serverUrl,
          machineName: currentComputerNames({ platform: platform.os }).name,
          hostname: hostname(),
          os: platform.os,
          write: io.stdout,
          onStage: options?.onStage,
        },
        fetch,
      ),
    serverUrl: COFORGE_SERVER_URL,
  });
  return {
    async run(workspaceSlug, options) {
      const result = await setup.run({
        workspaceSlug,
        json: options.json,
        oneShot: options.oneShot,
        onStage: attachStageEmitter(io, options.json),
      });
      writeSetupResult(io.stdout, result, options.json);
    },
  };
}
