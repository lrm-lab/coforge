import { afterEach, describe, expect, test } from "bun:test";
import { parseArgs, run, type MessageTransport } from "../index";
import { toActionCardAction } from "#src/action-prepare-input";
import { connectLocal } from "#src/local-client";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const TOKEN = `sfp_${"b".repeat(43)}`;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("P1-7 CLI collaboration commands", () => {
  test("parses and executes coforge inbox read across conversations, @app.<key>, and reminders", async () => {
    const parsed = parseArgs([
      "inbox",
      "read",
      "--target",
      "@app.github",
      "--limit",
      "5",
      "--cursor",
      "12",
    ]);
    expect(parsed).toEqual({
      command: "inbox-read",
      target: "@app.github",
      limit: 5,
      cursor: "12",
      json: false,
    });

    const calls: unknown[] = [];
    const transport = {
      async inboxRead(input: unknown) {
        calls.push(input);
        return {
          ok: true as const,
          kind: "app_events" as const,
          target: "@app.github",
          items: [
            {
              kind: "message" as const,
              id: "0196ed00-0000-7000-8000-000000000010",
              seq: 13,
              sender: "@app.github",
              createdAt: "2026-11-17T12:00:00.000Z",
              body: "[event] check_suite.completed: green",
            },
          ],
          hasMore: true,
          nextCursor: "13",
          readPositionAfter: 13,
        };
      },
    } as unknown as MessageTransport;

    const out = await run(
      ["inbox", "read", "--target", "@app.github", "--limit", "5", "--cursor", "12"],
      transport,
    );
    expect(calls).toEqual([{ target: "@app.github", limit: 5, cursor: "12" }]);
    expect(String(out)).toContain("@app.github");
    expect(String(out)).toContain("--cursor 13");

    const emptyWindowTransport = {
      async inboxRead() {
        return {
          ok: true as const,
          kind: "conversation" as const,
          target: "#general",
          items: [],
          hasMore: true,
          nextCursor: "25",
          readPositionAfter: 25,
        };
      },
    } as unknown as MessageTransport;
    const emptyWindowOut = await run(
      ["inbox", "read", "--target", "#general"],
      emptyWindowTransport,
    );
    expect(String(emptyWindowOut)).toContain("--cursor 25");
  });

  test("parses and executes coforge inbox dismiss with --target or --before and rejects invalid combinations", async () => {
    expect(parseArgs(["inbox", "dismiss", "--target", "#general"])).toEqual({
      command: "inbox-dismiss",
      target: "#general",
      json: false,
    });
    expect(parseArgs(["inbox", "dismiss", "--before", "2026-11-16T00:00:00Z", "--json"])).toEqual({
      command: "inbox-dismiss",
      before: "2026-11-16T00:00:00.000Z",
      json: true,
    });

    expect(() => parseArgs(["inbox", "dismiss"])).toThrow();
    expect(() =>
      parseArgs(["inbox", "dismiss", "--target", "#general", "--before", "2026-11-16T00:00:00Z"]),
    ).toThrow();
    expect(() => parseArgs(["inbox", "dismiss", "--before", "not-a-date"])).toThrow();

    const calls: unknown[] = [];
    const transport = {
      async inboxDismiss(input: unknown) {
        calls.push(input);
        return {
          ok: true as const,
          mode: "before" as const,
          dismissedConversations: 2,
          dismissedThreads: 1,
          dismissedAppTargets: 1,
          dismissedReminders: 1,
          targets: [
            "#general",
            "#ops",
            "@app.github",
            "reminder:0196ed00-0000-7000-8000-000000000099",
          ],
        };
      },
    } as unknown as MessageTransport;

    const out = await run(["inbox", "dismiss", "--before", "2026-11-16T00:00:00Z"], transport);
    expect(calls).toEqual([{ before: "2026-11-16T00:00:00.000Z" }]);
    expect(String(out)).toContain("Dismissed");
  });

  test("parses and executes coforge action withdraw --message <id> via local proxy and validates richer question cards", async () => {
    const messageId = "0196ed00-0000-7000-8000-000000000055";
    expect(parseArgs(["action", "withdraw", "--message", messageId])).toEqual({
      command: "action-withdraw",
      messageId,
      json: false,
    });
    expect(() => parseArgs(["action", "withdraw"])).toThrow();
    expect(() => parseArgs(["action", "withdraw", "--message", "not-a-uuid"])).toThrow();

    const received: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        received.push({ path: url.pathname, body: await req.json() });
        return Response.json({ ok: true, messageId, state: "cancelled" });
      },
    });
    servers.push(server);
    const local = connectLocal("", TOKEN, `http://127.0.0.1:${server.port}/api/agent/v1/messages`);

    const out = await run(["action", "withdraw", "--message", messageId], local);
    expect(received).toEqual([{ path: "/api/agent/v1/actions/withdraw", body: { messageId } }]);
    expect(out).toBe(`Action card ${messageId} withdrawn.`);
    expect(await run(["action", "withdraw", "--message", messageId, "--json"], local)).toEqual({
      ok: true,
      messageId,
      state: "cancelled",
    });

    const parsedCard = toActionCardAction({
      type: "questions",
      to: "anyone",
      expiresInMinutes: 45,
      questions: [
        {
          id: "confirm",
          prompt: "Confirm deploy?",
          options: [{ id: "ok", label: "Deploy" }],
        },
        {
          id: "context",
          kind: "text",
          prompt: "Any deploy window notes?",
          placeholder: "Optional notes",
        },
      ],
    });
    expect(parsedCard.type).toBe("questions");
  });

  test("combines positional #channel:#7 ref with --assignee and --reason on coforge task assign", () => {
    expect(
      parseArgs([
        "task",
        "assign",
        "#ops:#7",
        "--assignee",
        "@bob",
        "--reason",
        "Needs backend auth review",
      ]),
    ).toEqual({
      command: "task",
      task: {
        operation: "assign",
        target: "#ops",
        number: 7,
        assignee: "@bob",
        reason: "Needs backend auth review",
      },
    });
  });
});
