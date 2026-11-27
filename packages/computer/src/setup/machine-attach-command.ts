import { hostname } from "node:os";
import { isLockContention, type DaemonLauncher } from "@lrm/coforge-daemon";
import { ensureDaemonConfigured } from "#src/daemon-client/index";
import { CliError } from "#src/errors";
import { loadBuildProfile, type FileComputerConfig } from "#src/local-config";
import type { ComputerMetadataProvider, SetupResult, SetupResumePort } from "./computer-setup";
import { MachineAttachClient } from "./machine-attach-client";
import { runMachineAttach } from "./machine-attach-flow";
import { FileMachineAttachSecrets } from "./machine-attach-secrets";

type Options = {
  config: FileComputerConfig;
  serverUrl: string;
  workspaceRoot: string;
  metadata: ComputerMetadataProvider;
  resume: SetupResumePort;
  launcher: () => DaemonLauncher;
};

async function existingProof(options: Options, requestedSlug?: string) {
  const { config, resume } = options;
  const existing = requestedSlug ? await config.loadRegistration(requestedSlug) : null;
  if (existing) {
    const key = await resume.storedKey(existing.id, existing.computerId);
    const current = key ? await resume.self(key, AbortSignal.timeout(15_000)) : undefined;
    if (current?.state === "live" || (current?.state === "forbidden" && key?.startsWith("dk_")))
      return { alreadyLive: true };
    if (current?.state === "unreachable")
      throw new CliError(
        "ATTACH_NETWORK_FAILED",
        "Could not verify the existing Computer credential.",
        "Check the server connection and rerun coforge-computer attach.",
      );
    return {
      recover: {
        computerId: existing.computerId,
        workspaceId: existing.id,
        workspaceSlug: existing.slug,
      },
    };
  }
  for (const registration of await config.listRegistrations()) {
    const key = await resume.storedKey(registration.id, registration.computerId);
    if (!key) continue;
    const current = await resume.self(key, AbortSignal.timeout(15_000));
    if (current.state === "live" || (current.state === "forbidden" && key.startsWith("dk_")))
      return { source: { computerId: registration.computerId, key } };
  }
  return {};
}

export function createMachineAttachCommand(options: Options) {
  return async (input: {
    workspaceSlug?: string;
    show(line: string): void;
    onStage?: (stage: string, detail?: Record<string, string>) => void;
  }): Promise<SetupResult | undefined> => {
    const { config, serverUrl, workspaceRoot } = options;
    const profile = await loadBuildProfile(config, serverUrl, "setup");
    const client = new MachineAttachClient(serverUrl);
    if (!(await client.supported())) return undefined;
    const proof = await existingProof(options, input.workspaceSlug);
    if (proof.alreadyLive) return undefined;

    const launcher = options.launcher();
    await launcher.preflight?.();
    const secrets = new FileMachineAttachSecrets(serverUrl);
    const lock = await secrets.lock().catch((error: unknown) => {
      if (!isLockContention(error)) throw error;
      throw new CliError(
        "ATTACH_ALREADY_RUNNING",
        "Another attach is running on this Computer.",
        "Return to that terminal or retry after it stops.",
      );
    });
    try {
      const metadata = await options.metadata.get();
      const binding = await runMachineAttach({
        ...input,
        serverUrl,
        metadata,
        hostname: hostname(),
        ...proof,
        client,
        secrets,
      });
      if (!profile) await config.saveCurrentProfile({ serverUrl });
      const workspace = {
        id: binding.workspaceId,
        slug: binding.workspaceSlug,
        name: binding.workspaceSlug,
      };
      const started = await ensureDaemonConfigured(launcher, {
        workspaceId: binding.workspaceId,
        computerId: binding.computerId,
        workspaceRoot,
        daemonApiKey: binding.apiKey,
        serverHttpUrl: serverUrl,
        loginSetup: false,
      });
      const configPath = await config.saveRegistration({
        id: workspace.id,
        slug: workspace.slug,
        computerId: binding.computerId,
      });
      await secrets.clearPending(input.workspaceSlug ?? "");
      input.onStage?.("registered", {
        computerId: binding.computerId,
        workspaceSlug: workspace.slug,
      });
      input.onStage?.("saved", { configPath });
      return {
        workspace,
        configPath,
        serverUrl,
        computerId: binding.computerId,
        machineId: metadata.machineId,
        mode: binding.resumed ? "resumed" : "registered",
        ...(started?.lifecycleUnderWay ? { daemonStillStarting: true } : {}),
      };
    } finally {
      lock.release();
    }
  };
}
