import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerSetup } from "#src/setup/computer-setup";
import { FileComputerConfig } from "#src/local-config";

/** Task #417 staging-QA reproduction: drive a real one-shot `attach` against a fake web that
 * answers attach/start, attach/poll (pending, then the token on approve) and computer:register.
 * Records when the CLI resolves, when register fired relative to approve, and which files landed —
 * the "exit 0 before approval, nothing written" symptom QA saw must not be reproducible. */

test("a one-shot attach polls until approval, registers after it, and writes registration.json", async () => {
  const timeline: { at: number; event: string }[] = [];
  const mark = (event: string) => timeline.push({ at: Date.now(), event });
  let approved = false;
  let registered = false;
  const polls: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/computer/attach/start") {
        mark("attach/start");
        return Response.json({
          sessionId: "session-1",
          deviceCode: "device-secret",
          userCode: "ABCD-EFGH",
          approveUrl: "https://web.example/computers/attach/session-1",
          expiresInSeconds: 600,
        });
      }
      if (url.pathname === "/api/computer/attach/poll") {
        polls.push(Date.now());
        if (!approved) {
          mark("poll:pending");
          return Response.json({ error: "attach_pending" }, { status: 400 });
        }
        mark("poll:approved->token");
        return Response.json({
          attachToken: "at_secret",
          expiresInSeconds: 60,
          workspaceId: "workspace-id-a",
          workspaceSlug: "workspace-a",
        });
      }
      if (url.pathname === "/api/computer/v1/computer:register") {
        mark("register");
        registered = true;
        return Response.json({
          protocolMajor: 1,
          requestId: "req-1",
          computerId: "computer-id",
          workspaceId: "workspace-id-a",
          workspaceSlug: "workspace-a",
          daemonApiKey: "sk_computer_test",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "coforge-attach-repro-"));
  try {
    const serverUrl = `http://127.0.0.1:${server.port}`;
    const config = new FileComputerConfig(join(directory, "config"));
    // Approve after a couple of pending polls, so the poll loop is exercised.
    const approveAfter = 2;
    const setup = new ComputerSetup({
      config,
      workspaceRoot: join(directory, "workspaces"),
      credentials: {
        async load() {
          return null;
        },
      },
      workspaceLookup: {
        async getBySlug() {
          throw new Error("one-shot never lists workspaces");
        },
      } as any,
      oneShotAttach: async () => {
        const { oneShotAttach } = await import("#src/setup/one-shot-attach");
        return oneShotAttach(
          {
            serverUrl,
            machineName: "m",
            hostname: "h",
            os: "test",
            sleep: async () => {
              if (polls.length >= approveAfter) approved = true;
            },
          },
          fetch,
        );
      },
      registrationFactory: () => ({
        async register(request: { protocolMajor: number; requestId: string }) {
          const response = await fetch(`${serverUrl}/api/computer/v1/computer:register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          });
          return response.json();
        },
      }),
      launcher: { ensureStarted: async () => ({}) },
      metadataProvider: {
        async get() {
          return {
            name: "c",
            displayName: "C",
            platform: "linux",
            osVersion: "1",
            computerVersion: "dev",
            machineId: "m",
          };
        },
      },
      idempotencyKeyProvider: { create: (_s: string, v: string) => `key:${v}` },
      serverUrl,
    });
    const result = await setup.run({ oneShot: true });
    mark("cli-exit");

    // The CLI did not exit before approval: polls ran before register, register after approve.
    const approveIdx = timeline.findIndex((e) => e.event === "poll:approved->token");
    const registerIdx = timeline.findIndex((e) => e.event === "register");
    const exitIdx = timeline.findIndex((e) => e.event === "cli-exit");
    expect(approveIdx).toBeGreaterThan(-1);
    expect(registerIdx).toBeGreaterThan(approveIdx);
    expect(exitIdx).toBeGreaterThan(registerIdx);
    expect(registered).toBe(true);
    expect(polls.length).toBeGreaterThanOrEqual(approveAfter);
    // registration.json landed where FileComputerConfig writes it.
    const workspaces = await readdir(join(directory, "config", "workspaces"));
    const written = await Bun.file(
      join(directory, "config", "workspaces", workspaces[0]!, "registration.json"),
    ).json();
    expect(written.computerId ?? written.computer_id).toBe("computer-id");
    expect(result.workspace.slug).toBe("workspace-a");
    console.log("[repro] timeline:", timeline.map((e) => e.event).join(" -> "));
    console.log("[repro] files:", workspaces);
  } finally {
    server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
