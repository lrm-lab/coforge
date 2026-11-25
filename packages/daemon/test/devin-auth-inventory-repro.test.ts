import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVIN_AUTH_PROBE_TIMEOUT_MS,
  DEVIN_CATALOG_TIMEOUT_MS,
  DevinRuntimeAuthAdapter,
  readDevinModelEfforts,
} from "@lrm/coforge-anvil/devin";
import {
  decodeDaemonRuntimeProviderModelRefreshResponse,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  type DaemonRuntimeProviderModelRefreshResponse,
  type RuntimeAuthStatusReport,
} from "@lrm/coforge-sdk/internal";
import { runtimeAuthProcess } from "#src/code-agent/auth-process";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { RuntimeExecutableNotFoundError } from "#src/platform/runtime-executable-not-found";
import { devinRuntimeHost } from "#src/code-agent/devin/host";
import {
  discoverCodeAgentCatalogs,
  discoverCodeAgentRuntimes,
} from "#src/code-agent/runtime-inventory";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import {
  ProviderProbeCoordinator,
  REPROBE_MIN_INTERVAL_MS,
} from "#src/daemon-runtime/code-agent-provider-probe";
import { RuntimeAuthReporter } from "#src/daemon-runtime/runtime-auth-reporter";
import { spawnedCatalogDiscoveryBudgetMs } from "./catalog-discovery-budget";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const version = "3000.14.30821";
const owner = { computerId: "fixture-computer", workspaceId: "fixture-workspace" };
const timeoutMs =
  3 * spawnedCatalogDiscoveryBudgetMs(DEVIN_CATALOG_TIMEOUT_MS) + 4 * DEVIN_AUTH_PROBE_TIMEOUT_MS;
type Runtimes = Awaited<ReturnType<typeof discoverCodeAgentRuntimes>>;

async function withScenario(
  run: (scenario: Awaited<ReturnType<typeof createScenario>>) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "coforge-devin-inventory-"));
  try {
    await run(await createScenario(cwd));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

type AcpResponse = {
  id: number;
  error?: { code: number; message: string; data?: Record<string, unknown> };
  result?: {
    configOptions?: Array<{
      id: string;
      currentValue: string;
      options: Array<{ value: string; name: string }>;
    }>;
  };
};

async function createScenario(cwd: string) {
  const fixture = await Bun.file(anvilRuntimeFixtures.devin).text();
  const executable = join(cwd, "devin-fixture.ts");
  const replyLog = join(cwd, "acp-replies.jsonl");
  const send = "const write = (value: unknown) => console.log(JSON.stringify(value));";
  const sessionNew = '    case "session/new":';
  if (!fixture.includes(send) || !fixture.includes(sessionNew))
    throw new Error("Devin diagnostic fixture shape changed");
  await Bun.write(
    executable,
    'import { appendFileSync } from "node:fs";\n' +
      `if (process.argv.slice(-2).join(" ") === "auth status") {
        const signedIn = Bun.env.DEVIN_FIXTURE_AUTH === "1";
        console.log(signedIn ? "Logged in (via Devin)." : "Not logged in.");
        process.exit(signedIn ? 0 : 1);
      }\n` +
      fixture
        .replace("3000.11.228 (053434014dbd)", version + " (fixture)")
        .replaceAll("claude-opus-5-5-medium", "swe-2.1-medium")
        .replaceAll("Claude Opus 5.5 Medium", "SWE-2.1 Medium")
        .replace(
          send,
          `const write = (value: unknown) => {
          const line = JSON.stringify(value);
          appendFileSync(Bun.env.DEVIN_FIXTURE_REPLY_LOG!, line + "\\n");
          console.log(line);
        };`,
        )
        .replace(
          sessionNew,
          sessionNew +
            `
          if (Bun.env.DEVIN_FIXTURE_FAILURE) {
            const kind = Bun.env.DEVIN_FIXTURE_FAILURE;
            write({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: kind === "internal_error" ? -32603 : -32000,
                message: "Synthetic catalog error",
                ...(kind === "auth_code_only" ? {} : { data: { "cognition.ai/errorKind": kind } }),
              },
            });
            break;
          }`,
        ),
  );
  let installed = false;
  let signedIn = false;
  let spawnError: Error | undefined;
  let catalogFailure: string | undefined;
  const reports: RuntimeAuthStatusReport[] = [];
  const command = [process.execPath, executable, "acp"];
  const refreshResponses: DaemonRuntimeProviderModelRefreshResponse[] = [];
  const environment = () => ({
    HOME: cwd,
    PATH: cwd,
    PI_OFFLINE: "1",
    DEVIN_FIXTURE_LOG: join(cwd, "acp.jsonl"),
    DEVIN_FIXTURE_REPLY_LOG: replyLog,
    DEVIN_FIXTURE_PROTOCOL: signedIn || catalogFailure ? "1" : "0",
    DEVIN_FIXTURE_AUTH: signedIn ? "1" : "0",
    ...(catalogFailure ? { DEVIN_FIXTURE_FAILURE: catalogFailure } : {}),
  });
  const lookup = () => ({
    probe: {
      which: (name: string) => (installed && name === "devin" ? executable : undefined),
      spawn: (path: string, env?: Record<string, string | undefined>) => {
        expect(path).toBe(executable);
        return Bun.spawn([process.execPath, path, "--version"], { env, stdout: "pipe" });
      },
    },
    cwd,
    platform: "linux" as const,
    environment: environment(),
    piModels: async () => [],
    commands: { devin: command },
  });
  const transport = {
    async sendProviderModelRefreshResult(reply: DaemonRuntimeProviderModelRefreshResponse) {
      refreshResponses.push(
        decodeDaemonRuntimeProviderModelRefreshResponse(
          encodeDaemonRuntimeProviderModelRefreshResponse(reply),
        ),
      );
    },
    async reportRuntimeAuthStatus(report: RuntimeAuthStatusReport) {
      reports.push(report);
    },
  } as DaemonConnectionClient;
  const adapter = new DevinRuntimeAuthAdapter({
    terminalLoginSupported: false,
    maskAccountLabel: () => undefined,
    spawn(args) {
      expect(args).toEqual(["auth", "status"]);
      if (spawnError) throw spawnError;
      return runtimeAuthProcess(
        processSpawner.spawn(
          [process.execPath, executable, ...args],
          cwd,
          agentEnvironment(undefined, environment()),
        ),
      );
    },
  });
  const reporter = new RuntimeAuthReporter({
    owner,
    workingDirectory: cwd,
    transport: () => transport,
    isStopping: () => false,
    createAdapter: (provider) => {
      expect(provider).toBe("devin");
      return adapter;
    },
  });
  let clockMs = Date.now();
  let visibleRuntimes: Runtimes = [];
  const discovery = {
    runtimes: () => discoverCodeAgentRuntimes(lookup()),
    catalogs: (runtimes: Runtimes) =>
      discoverCodeAgentCatalogs(runtimes, { ...lookup(), provider: "devin" }),
  };
  const coordinator = new ProviderProbeCoordinator({
    discovery: discovery as ConstructorParameters<typeof ProviderProbeCoordinator>[0]["discovery"],
    owner,
    isLive: () => true,
    runtimeAuth: reporter,
    now: () => clockMs,
    serialize: (work) => work(),
    settle() {},
    async sendInventory(_transport, _request, runtimes) {
      visibleRuntimes = runtimes;
    },
    onReported() {},
    reportedRuntimes: () => visibleRuntimes,
    async resolveEfforts() {
      return undefined;
    },
    sweepableProviders: new Set(),
  });
  await reporter.inventoryReported(await discovery.runtimes());
  return {
    remove: () => {
      installed = false;
    },
    install: () => {
      installed = true;
    },
    reconcileInventory: async () => reporter.inventoryObserved(await discovery.runtimes()),
    signIn: () => {
      signedIn = true;
    },
    failCatalog: (kind: string) => {
      catalogFailure = kind;
    },
    failAuthSpawn: (error: Error) => {
      spawnError = error;
    },
    responses: async (): Promise<AcpResponse[]> =>
      (await Bun.file(replyLog).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    probe: () => coordinator.enqueue("devin", transport),
    refreshModels: async () => {
      clockMs += REPROBE_MIN_INTERVAL_MS;
      await coordinator.refreshProvider(
        { protocolMajor: 1, requestId: "refresh-models", provider: "devin", ...owner },
        transport,
      );
      return refreshResponses.at(-1)?.results;
    },
    devin: () => visibleRuntimes.find((runtime) => runtime.provider === "devin"),
    refreshAuth: () => reporter.refreshProvider("devin", { force: true }),
    auth: () => reports.at(-1)?.runtimes.find((status) => status.provider === "devin"),
    modelEfforts: () =>
      readDevinModelEfforts(command, cwd, environment(), devinRuntimeHost, ["swe-2.1-medium"]),
  };
}

test(
  "absence, explicit logged-out, and successful sign-in stay distinct",
  async () => {
    await withScenario(async (scenario) => {
      expect(scenario.auth()).toEqual({
        provider: "devin",
        state: "unavailable",
        unavailableReason: "not_installed",
      });
      scenario.install();
      await scenario.probe();
      await scenario.refreshAuth();
      expect(scenario.auth()?.state).toBe("logged_out");
      scenario.signIn();
      const probe = await scenario.probe();
      await scenario.refreshAuth();
      expect(scenario.auth()?.state).toBe("logged_in");
      expect(probe.catalogs.find((catalog) => catalog.provider === "devin")?.models).toContainEqual(
        expect.objectContaining({ id: "swe-2.1-medium", displayName: "SWE-2.1 Medium" }),
      );
      const modelEfforts = (await scenario.modelEfforts()).get("swe-2.1-medium");
      if (modelEfforts?.status !== "ready") throw new Error("Fixture did not report model efforts");
      expect(modelEfforts.efforts).toContain("high");
      const switched = (await scenario.responses()).find(({ result }) =>
        result?.configOptions?.some(
          (option) => option.id === "model" && option.currentValue === "swe-2.1-medium",
        ),
      );
      const model = switched?.result?.configOptions?.find(({ id }) => id === "model");
      const thought = switched?.result?.configOptions?.find(({ id }) => id === "thought_level");
      expect(model?.options).toContainEqual(
        expect.objectContaining({ value: "swe-2.1-medium", name: "SWE-2.1 Medium" }),
      );
      expect(thought?.options).toContainEqual({ value: "high", name: "High" });
      console.info(
        JSON.stringify({ case: "synthetic-acp-model-and-thought-level", model, thought }),
      );
      scenario.remove();
      await scenario.reconcileInventory();
      expect(scenario.auth()).toMatchObject({ unavailableReason: "not_installed" });
      scenario.install();
      await scenario.reconcileInventory();
      expect(scenario.auth()).toMatchObject({ state: "logged_in" });
    });
  },
  timeoutMs,
);

test.each([
  ["auth_required", -32000],
  ["auth_code_only", -32000],
  ["internal_error", -32603],
] as const)(
  "diagnoses a structured Devin ACP %s rejection",
  async (kind, code) => {
    await withScenario(async (scenario) => {
      scenario.install();
      if (kind !== "auth_required") scenario.signIn();
      scenario.failCatalog(kind);
      const results = await scenario.refreshModels();
      await scenario.refreshAuth();
      const native = (await scenario.responses()).find((response) => response.error)?.error;
      expect(scenario.devin()?.version).toBe(version);
      expect(scenario.auth()?.state).toBe(kind === "auth_required" ? "logged_out" : "logged_in");
      expect(native?.code).toBe(code);
      expect(native?.data).toEqual(
        kind === "auth_code_only" ? undefined : { "cognition.ai/errorKind": kind },
      );
      console.info(
        JSON.stringify({
          case: kind,
          rawAcpError: native,
          results,
          auth: scenario.auth()?.state,
        }),
      );
      expect(results).toHaveLength(1);
      if (kind === "internal_error") {
        expect(results?.[0]).toEqual({ provider: "devin", status: "error", code: "unknown" });
      } else {
        expect(results?.[0]).toEqual({
          status: "error",
          provider: "devin",
          code: "probe_failed",
          diagnostic: "Sign in on this Computer or check your Devin account permissions",
        });
      }
    });
  },
  timeoutMs,
);

test(
  "a detected Devin reports unknown if its auth process cannot start",
  async () => {
    await withScenario(async (scenario) => {
      scenario.install();
      scenario.failAuthSpawn(new RuntimeExecutableNotFoundError("devin"));
      await scenario.probe();
      await scenario.refreshAuth();
      expect(scenario.devin()?.version).toBe(version);
      expect(scenario.auth()).toEqual({ provider: "devin", state: "unknown" });
      scenario.failAuthSpawn(new Error("fixture spawn permission failure"));
      await scenario.refreshAuth();
      expect(scenario.auth()).toMatchObject({ state: "unknown" });
      console.info(JSON.stringify({ case: "known-install-with-auth-spawn-failure", version }));
    });
  },
  timeoutMs,
);
