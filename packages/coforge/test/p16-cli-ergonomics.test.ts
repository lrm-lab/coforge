import { afterEach, describe, expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { CliError } from "#src/cli-error";
import { connectLocal } from "#src/local-client";
import { connectAppClient } from "#src/app-client";
import { connectAppRegistrationClient } from "#src/app-registration-client";
import { connectAppManagementClient } from "#src/app-management-client";
import { commandGuidanceLine } from "#src/command-guidance";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const TOKEN = `sfp_${"a".repeat(43)}`;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("P1-6 CLI ergonomics", () => {
  test("message send --discard-draft parses [--expected-draft-key], rejects conflicting flags, and discards via transport", async () => {
    expect(parseArgs(["message", "send", "--target", "#general", "--discard-draft"])).toEqual({
      command: "send",
      target: "#general",
      discardDraft: true,
    });
    expect(
      parseArgs([
        "message",
        "send",
        "--target",
        "#general",
        "--discard-draft",
        "--expected-draft-key",
        "key-1",
        "--json",
      ]),
    ).toEqual({
      command: "send",
      target: "#general",
      discardDraft: true,
      expectedDraftKey: "key-1",
      json: true,
    });

    expect(() =>
      parseArgs(["message", "send", "--target", "#general", "--discard-draft", "--send-draft"]),
    ).toThrow(CliError);
    expect(() =>
      parseArgs(["message", "send", "--target", "#general", "--discard-draft", "--anyway"]),
    ).toThrow(CliError);
    expect(() =>
      parseArgs(["message", "send", "--target", "#general", "--expected-draft-key", "k1"]),
    ).toThrow(/--send-draft or --discard-draft/);

    const sentPayloads: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        sentPayloads.push(await req.json());
        return Response.json({
          idempotencyKey: "k-req",
          accepted: true,
          clearedDraft: true,
          discarded: true,
          discardedDraftKey: "key-1",
          target: "#general",
        });
      },
    });
    servers.push(server);
    const local = connectLocal("", TOKEN, `http://127.0.0.1:${server.port}/api/agent/v1/messages`);

    const textOut = await run(
      [
        "message",
        "send",
        "--target",
        "#general",
        "--discard-draft",
        "--expected-draft-key",
        "key-1",
      ],
      local,
    );
    expect(textOut).toBe("Draft for #general discarded; nothing was sent.");
    expect(sentPayloads[0]).toMatchObject({
      operation: "send",
      target: "#general",
      discardDraft: true,
      expectedDraftKey: "key-1",
    });

    const jsonOut = await run(
      ["message", "send", "--target", "#general", "--discard-draft", "--json"],
      local,
    );
    expect(JSON.parse(String(jsonOut))).toEqual({
      state: "discarded",
      target: "#general",
      discarded: true,
      idempotencyKey: "key-1",
    });
  });

  test("task board commands accept positional '#channel:#7' and 'dm:@peer:#7' references", () => {
    expect(parseArgs(["task", "claim", "#coforge:#7"])).toEqual({
      command: "task",
      task: { operation: "claim", target: "#coforge", number: 7 },
    });
    expect(parseArgs(["task", "claim", "#coforge:#7", "#coforge:#9"])).toEqual({
      command: "task",
      task: { operation: "claim", target: "#coforge", numbers: [7, 9] },
    });
    expect(parseArgs(["task", "unclaim", "#coforge:#7"])).toEqual({
      command: "task",
      task: { operation: "unclaim", target: "#coforge", number: 7 },
    });
    expect(
      parseArgs([
        "task",
        "assign",
        "#coforge:#7",
        "--assignee",
        "@bob",
        "--reason",
        "Take over API route",
      ]),
    ).toEqual({
      command: "task",
      task: {
        operation: "assign",
        target: "#coforge",
        number: 7,
        assignee: "@bob",
        reason: "Take over API route",
      },
    });
    expect(parseArgs(["task", "unassign", "dm:@ada:#3"])).toEqual({
      command: "task",
      task: { operation: "unassign", target: "@ada", number: 3 },
    });
    expect(parseArgs(["task", "update", "#coforge:#7", "--status", "in_progress"])).toEqual({
      command: "task",
      task: { operation: "update", target: "#coforge", number: 7, status: "in_progress" },
    });
    expect(parseArgs(["task", "amend", "#coforge:#7", "--title", "Updated title"])).toEqual({
      command: "task",
      task: { operation: "amend", target: "#coforge", number: 7, title: "Updated title" },
    });
    expect(parseArgs(["task", "delete", "#coforge:#7"])).toEqual({
      command: "task",
      task: { operation: "delete", target: "#coforge", number: 7 },
    });
    expect(parseArgs(["task", "show", "#coforge:#7", "--json"])).toEqual({
      command: "task",
      json: true,
      task: { operation: "show", target: "#coforge", number: 7 },
    });
    expect(parseArgs(["task", "history", "dm:@ada:#12"])).toEqual({
      command: "task",
      task: { operation: "history", target: "@ada", number: 12 },
    });

    // Disagreement between positional ref and --target/--number is refused.
    expect(() =>
      parseArgs(["task", "show", "#coforge:#7", "--target", "#other", "--number", "7"]),
    ).toThrow(/different tasks/);
    expect(() => parseArgs(["task", "claim", "#coforge:#7", "#other:#8"])).toThrow(CliError);
  });

  test("thread follow accepts positional or --target channel thread and wires through connectLocal", async () => {
    expect(parseArgs(["thread", "follow", "#general:12345678"])).toEqual({
      command: "thread-follow",
      target: "#general:12345678",
    });
    expect(parseArgs(["thread", "follow", "--target", "#general:12345678"])).toEqual({
      command: "thread-follow",
      target: "#general:12345678",
    });
    expect(() => parseArgs(["thread", "follow", "#general"])).toThrow(CliError);

    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push(`${req.method} ${url.pathname}`);
        return Response.json({
          idempotencyKey: "k1",
          target: "#general:12345678",
          followed: true,
        });
      },
    });
    servers.push(server);
    const local = connectLocal("", TOKEN, `http://127.0.0.1:${server.port}/api/agent/v1/messages`);
    const output = await run(["thread", "follow", "#general:12345678"], local);
    expect(requests).toEqual(["POST /api/agent/v1/threads/%23general%3A12345678/follow"]);
    expect(output).toContain("Followed #general:12345678.");
  });

  test("app and artifact clients route through createAgentApiClient and preserve error semantics", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/agent/v1/apps") {
          return Response.json({ ok: true, apps: [] });
        }
        if (url.pathname === "/api/agent/v1/app-registrations") {
          const body = (await req.json()) as { operation: string };
          if (body.operation === "owned_list")
            return Response.json({ ok: true, pending: [], apps: [] });
          if (body.operation === "delete")
            return Response.json({ ok: true, clientKey: "demo", deleted: true });
        }
        return Response.json(
          { ok: false, errorCode: "app_not_found", error: "no such app" },
          { status: 404 },
        );
      },
    });
    servers.push(server);
    const proxyUrl = `http://127.0.0.1:${server.port}/api/agent/v1/messages`;

    const appClient = connectAppClient(TOKEN, proxyUrl);
    expect(await appClient.appList()).toEqual({ ok: true, apps: [] });

    const regClient = connectAppRegistrationClient(TOKEN, proxyUrl);
    expect(await regClient.owned()).toEqual({ ok: true, pending: [], apps: [] });

    const mgmtClient = connectAppManagementClient(TOKEN, proxyUrl);
    expect(await mgmtClient.call("delete", { clientKey: "demo" })).toEqual({
      ok: true,
      clientKey: "demo",
      deleted: true,
    });
  });

  test("commandGuidanceLine pre-satisfies on --help, suppresses on --json, and prints progressive hint", async () => {
    const calls: unknown[] = [];
    const fakeTransport = {
      commandGuidance: async (req: { operation: "check" | "satisfy"; command: string }) => {
        calls.push(req);
        if (req.operation === "satisfy") return { ok: true as const, guidance: null };
        return {
          ok: true as const,
          guidance: "[Tip] Pass '#channel:#7' directly to task commands.",
        };
      },
    };

    expect(await commandGuidanceLine(fakeTransport, ["task", "claim", "--json"])).toBeUndefined();
    expect(calls).toHaveLength(0);

    expect(await commandGuidanceLine(fakeTransport, ["task", "--help"])).toBeUndefined();
    expect(calls).toEqual([{ operation: "satisfy", command: "task" }]);

    expect(await commandGuidanceLine(fakeTransport, ["task", "claim", "#coforge:#7"])).toBe(
      "[Tip] Pass '#channel:#7' directly to task commands.",
    );
  });
});
