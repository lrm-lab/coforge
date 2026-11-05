import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DROID_DEVICE_URL,
  DroidRuntimeAuthAdapter,
  type DroidAuthHost,
  type DroidAuthProcess,
} from "#src/droid/auth";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/droid-auth.ts", import.meta.url).pathname;

function ownedProcess(child: ReturnType<typeof Bun.spawn>): DroidAuthProcess {
  return {
    output: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const pump = async (stream: ReadableStream<Uint8Array>) => {
            for await (const chunk of stream) controller.enqueue(chunk);
          };
          void Promise.all([pump(child.stdout), pump(child.stderr)]).then(
            () => controller.close(),
            () => controller.close(),
          );
        },
      }),
    ).body!,
    exited: child.exited,
    write: (text) => void child.stdin.write(text),
    dispose: async () => {
      child.kill("SIGTERM");
      await child.exited.catch(() => undefined);
    },
  };
}

async function fixture(environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "anvil-droid-auth-"));
  const statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({ state: "logged_out" }));
  const logged: string[] = [];
  const env = {
    ...process.env,
    DROID_AUTH_FIXTURE_STATE: directory,
    ...environment,
  } as Record<string, string>;
  const host: DroidAuthHost = {
    command: [process.execPath, FIXTURE],
    environment: env,
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    clientInfo: { name: "droid-auth-fixture", version: "1" },
    interactiveLoginSupported: true,
    factoryApiKeyConfigured: false,
    spawn: (args, cwd) =>
      ownedProcess(
        Bun.spawn({
          cmd: [process.execPath, FIXTURE, ...args],
          cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
    // The daemon masks a real address; the contract only accepts a label carrying the mask marker.
    maskAccountLabel: (value) => value.replace(/^[^@]+/, "pro****"),
    logUnmatchedLoginOutput: (text) => logged.push(text),
  };
  const adapter = new DroidRuntimeAuthAdapter({
    host,
    codeTimeoutMs: 1_500,
    loginTimeoutMs: 5_000,
    pollIntervalMs: 100,
  });
  return {
    adapter,
    host,
    directory,
    logged,
    setState: (state: string) => writeFile(statePath, JSON.stringify({ state })),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const interaction = (signal?: AbortSignal) => {
  const events: Array<{ kind: string; verificationUrl?: string; userCode?: string }> = [];
  return {
    events,
    interaction: {
      onEvent: (event: { kind: string; verificationUrl?: string; userCode?: string }) =>
        events.push(event),
      prompt: async () => "",
      ...(signal ? { signal } : {}),
    },
  };
};

test("status reads the credential store: a stored session, an API key, and signed out", async () => {
  const f = await fixture();
  try {
    await f.setState("logged_in");
    expect(await f.adapter.readStatus({ workingDirectory: f.directory })).toMatchObject({
      provider: "droid",
      state: "logged_in",
      account: { maskedLabel: "pro****@example.com", methodLabel: "Factory account" },
    });
    await f.setState("api_key");
    expect(await f.adapter.readStatus({ workingDirectory: f.directory })).toMatchObject({
      provider: "droid",
      state: "logged_in",
      account: { methodLabel: "Factory API key" },
    });
    await f.setState("logged_out");
    expect(await f.adapter.readStatus({ workingDirectory: f.directory })).toEqual({
      provider: "droid",
      state: "logged_out",
    });
  } finally {
    await f.cleanup();
  }
});

test("a login shows the device code, then reports the sign-in the credential store sees", async () => {
  const f = await fixture({ DROID_AUTH_FIXTURE_COMPLETE_AFTER_MS: "600" });
  try {
    const { events, interaction: i } = interaction();
    const result = await f.adapter.startLogin({ workingDirectory: f.directory }, i);
    expect(events).toEqual([
      { kind: "device_code", verificationUrl: DROID_DEVICE_URL, userCode: "SMBZ-WNMD" },
    ]);
    expect(result).toMatchObject({ status: "logged_in", authStatus: { state: "logged_in" } });
  } finally {
    await f.cleanup();
  }
});

test("a login that prints no code fails as interaction_failed and logs what it read", async () => {
  const f = await fixture({ DROID_AUTH_FIXTURE_NO_CODE: "1" });
  try {
    const result = await f.adapter.startLogin(
      { workingDirectory: f.directory },
      interaction().interaction,
    );
    expect(result).toEqual({
      status: "failed",
      reason: "interaction_failed",
      detail: "droid_code_unavailable",
    });
    expect(f.logged.join("")).toContain("Please login with your Factory account");
  } finally {
    await f.cleanup();
  }
});

test("closing the dialog cancels the login and drops its process", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const { events, interaction: i } = interaction(abort.signal);
    const pending = f.adapter.startLogin({ workingDirectory: f.directory }, i);
    for (let index = 0; index < 100 && events.length === 0; index++) await Bun.sleep(20);
    expect(events.length).toBe(1);
    abort.abort();
    expect(await pending).toEqual({ status: "cancelled" });
  } finally {
    await f.cleanup();
  }
});

test("signing out clears the stored login through the server's own logout", async () => {
  const f = await fixture();
  try {
    await f.setState("logged_in");
    const result = await f.adapter.logout({ workingDirectory: f.directory });
    expect(result).toMatchObject({ status: "logged_out", authStatus: { state: "logged_out" } });
  } finally {
    await f.cleanup();
  }
});

test("an environment API key cannot be signed out", async () => {
  const f = await fixture();
  try {
    await f.setState("logged_in");
    const adapter = new DroidRuntimeAuthAdapter({
      host: { ...f.host, factoryApiKeyConfigured: true },
      codeTimeoutMs: 1_500,
      loginTimeoutMs: 5_000,
      pollIntervalMs: 100,
    });
    expect(await adapter.logout({ workingDirectory: f.directory })).toMatchObject({
      status: "failed",
      reason: "still_logged_in",
    });
    // The stored session is untouched: the key, not the logout, is what keeps it signed in.
    expect((await f.adapter.readStatus({ workingDirectory: f.directory })).state).toBe("logged_in");
  } finally {
    await f.cleanup();
  }
});
