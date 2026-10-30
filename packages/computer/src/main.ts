#!/usr/bin/env bun

export {};

// Startup timing for the Daemon's first log line (`startup-timing.ts` in the daemon package reads
// every `coforge:startup:` mark); written here because nothing else is loaded yet.
performance.mark("coforge:startup:main");

// Dispatch before importing either runtime so Agent commands never initialize
// Computer logging, Daemon sockets, or Workspace recovery.
if (Bun.argv[2] === "__pi-chat") {
  const workspaceId = Bun.env.COFORGE_PI_CHAT_WORKSPACE_ID ?? "";
  const userId = Bun.env.COFORGE_PI_CHAT_USER_ID ?? "";
  const stream = Bun.env.COFORGE_PI_CHAT_STREAM === "1";
  // This standalone session has no platform Agent identity or Daemon capabilities.
  for (const key of Object.keys(Bun.env)) if (key.startsWith("COFORGE_")) delete Bun.env[key];
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveComputerStateDirectory } = await import("./paths");
  const { configurePiChatLogging, runPiChatWorker } = await import("@coforge/agent");
  // Logs go to stderr through LogTape; stdout stays the JSONL protocol channel. The worker's own
  // logging is best effort and must never take the worker down with it.
  await configurePiChatLogging().catch(() => {});
  const state = resolveComputerStateDirectory({
    platform: process.platform,
    homeDirectory: homedir(),
    environment: Bun.env,
  });
  await runPiChatWorker(join(state, "pi-chat"), workspaceId, userId, { stream });
} else if (Bun.argv[2] === "__agent-cli") {
  const { runAgentCli } = await import("@lrm/coforge/runner");
  await runAgentCli(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__daemon") {
  const { runMachineSupervisor } = await import("@lrm/coforge-daemon");
  performance.mark("coforge:startup:daemon_imported");
  // Belt and braces: shutdown here is fully awaited - `runMachineSupervisor` only
  // resolves after every Coordinator-owned background wait (the upgrade receipt watch, in
  // particular) has been cancelled and its logging disposed. Exiting explicitly the moment it
  // resolves means a background wait this entrypoint failed to cancel can no longer keep the
  // process alive past its own shutdown, the way an uncancelled one did on 2026-09-17.
  try {
    await runMachineSupervisor(Bun.argv.slice(3));
    process.exit(process.exitCode ?? 0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else if (Bun.argv[2] === "__managed-agent") {
  const { runLaunchdAgent } = await import("@lrm/coforge-daemon");
  // No explicit exit added here: `runLaunchdAgent`'s own promise resolves as soon as its relay
  // socket connects, long before the relayed Agent process (or the socket) ends - shutdown is not
  // "fully awaited" by this call, unlike `__daemon`/`__workspace-daemon` below. The process
  // already terminates through the `process.exit` calls inside `runLaunchdAgent` itself, at each
  // real end of life (child exit, socket close, socket error); exiting here too would kill the
  // relay the moment it connects.
  await runLaunchdAgent(Bun.argv[3]!);
} else if (Bun.argv[2] === "__workspace-daemon") {
  const { runDaemon } = await import("@lrm/coforge-daemon");
  performance.mark("coforge:startup:daemon_imported");
  const { COFORGE_COMPUTER_VERSION } = await import("./version");
  // Belt and braces, same reasoning as `__daemon`: `runDaemon` only resolves once its
  // own SIGINT/SIGTERM shutdown has stopped every Workspace runtime, closed the Agent proxy and
  // local RPC server, and disposed logging.
  try {
    await runDaemon(Bun.argv.slice(3), COFORGE_COMPUTER_VERSION);
    process.exit(process.exitCode ?? 0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else if (Bun.argv[2] === "__attach-workspace") {
  const { homedir } = await import("node:os");
  const { COFORGE_DAEMON_SERVER_URL, LocalDaemonLauncher } = await import("@lrm/coforge-daemon");
  const { attachRunningWorkspace } = await import("./host/container-binding");
  const { resolveComputerStateDirectory, resolveDaemonSocketPath } = await import("./paths");
  const { currentComputerPlatform } = await import("./platform");
  const platform = currentComputerPlatform();
  const stateDirectory = resolveComputerStateDirectory({
    platform: platform.os,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const launcher = new LocalDaemonLauncher({
    executablePath: process.execPath,
    socketPath: resolveDaemonSocketPath({ platform: platform.os, stateDirectory }),
    stateDirectory,
    serverUrl: COFORGE_DAEMON_SERVER_URL,
  });
  const wrote = await attachRunningWorkspace(
    process.env,
    stateDirectory,
    COFORGE_DAEMON_SERVER_URL,
    (config) => launcher.ensureStarted(config).then(() => undefined),
  );
  if (!wrote) {
    console.error("attach environment is incomplete");
    process.exit(1);
  }
} else if (Bun.argv[2] === "__print-path") {
  // Run by the login shell the Coordinator probes: records this process's PATH, nothing else.
  const { writeLoginShellPathProbe } =
    await import("@lrm/coforge-daemon/src/platform/login-shell-path");
  try {
    await writeLoginShellPathProbe(Bun.argv[3] ?? "", Bun.argv[4] ?? "");
    process.exit(0);
  } catch {
    process.exit(1);
  }
} else if (Bun.argv[2] === "__lifecycle") {
  const { runLifecycleCommand } = await import("#src/release/lifecycle-command");
  process.exitCode = await runLifecycleCommand(Bun.argv.slice(3));
} else if (Bun.argv[2] === "__remote-upgrade") {
  // The operation is built once, here, from arguments alone; nothing downstream reads the
  // environment for its identity.
  const { parseRemoteUpgradeOperation } = await import("#src/release/upgrade-operation");
  const operation = parseRemoteUpgradeOperation(Bun.argv.slice(2));
  const { configureComputerLogger } = await import("#src/logging/computer-logger");
  const { resolveComputerConfigDirectory } = await import("#src/paths");
  const { COFORGE_COMPUTER_VERSION } = await import("./version");
  const logging = await configureComputerLogger({
    dataDirectory: resolveComputerConfigDirectory({
      platform: process.platform,
      homeDirectory: (await import("node:os")).homedir(),
      environment: Bun.env,
    }),
    version: COFORGE_COMPUTER_VERSION,
  }).catch(() => undefined);
  const { runRemoteUpgrade } = await import("#src/release/remote-upgrade");
  try {
    await runRemoteUpgrade(
      operation,
      logging
        ? {
            writeLog: (line) =>
              logging.logger.info("Remote Computer upgrade launch", {
                event: "computer:remote_upgrade",
                request_id: operation.requestId,
                line,
              }),
          }
        : undefined,
    );
  } finally {
    if (logging) await logging.close().catch(() => {});
  }
} else {
  const { runComputer } = await import("./cli");
  await runComputer();
}
