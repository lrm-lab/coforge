import { expect, spyOn, test } from "bun:test";
import { formatHeldSend } from "#src/message-format";
import { parseArgs, run } from "../index";

test("message continue parses the continuation id and choice", () => {
  expect(parseArgs(["message", "continue", "cont-1", "b"])).toEqual({
    command: "continue",
    continuationId: "cont-1",
    continuationChoice: "b",
  });
  expect(() => parseArgs(["message", "continue", "cont-1"])).toThrow();
  expect(() => parseArgs(["message", "continue", "cont-1", "e"])).toThrow();
  expect(() => parseArgs(["message", "continue"])).toThrow();
});

test("message continue a answers through the transport and reports the sent message", async () => {
  let call: unknown;
  const output = await run(["message", "continue", "cont-1", "a"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    continue: async (id, choice, body) => {
      call = { id, choice, body };
      return { accepted: true, continuationTarget: "#general", messageId: "message-7" };
    },
  });
  expect(call).toEqual({ id: "cont-1", choice: "a", body: undefined });
  expect(String(output)).toContain("Message sent to #general. Message ID: message-7");
});

test("message continue c reports the discarded draft", async () => {
  const output = await run(["message", "continue", "cont-1", "c"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    continue: async () => ({
      accepted: true,
      clearedDraft: true,
      continuationTarget: "#general",
    }),
  });
  expect(output).toBe("Draft for #general discarded; nothing was sent.");
});

test("message continue b pipes stdin as the body and reports an already-committed replay", async () => {
  // `Bun.stdin` is the one process-wide stream; mock it so the test neither drains it for other
  // files nor depends on what the harness piped.
  const bodyStream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("replacement body"));
      controller.close();
    },
  });
  const stdinSpy = spyOn(Bun.stdin, "stream").mockReturnValue(bodyStream);
  let call: unknown;
  try {
    const output = await run(["message", "continue", "cont-1", "b"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      continue: async (id, choice, body) => {
        call = { id, choice, body };
        return {
          accepted: true,
          replayedOriginal: true,
          messageId: "original-1",
          continuationTarget: "#general",
        };
      },
    });
    expect(output).toBe(
      "Already sent — the original message was delivered as original-1; the replacement content was NOT sent.",
    );
  } finally {
    stdinSpy.mockRestore();
  }
  expect(call).toEqual({ id: "cont-1", choice: "b", body: "replacement body" });
});

test("message continue d reports an already-committed draft send as delivered", async () => {
  const output = await run(["message", "continue", "cont-1", "d"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    continue: async () => ({
      accepted: true,
      replayedOriginal: true,
      messageId: "original-1",
      continuationTarget: "#general",
    }),
  });
  expect(output).toBe("Already sent — the message was already delivered as original-1.");
});

test("formatHeldSend renders the continuation choices when the daemon offers one", () => {
  const output = formatHeldSend("#general", {
    decision: "local_hold",
    newMessageCount: 1,
    continuation: { id: "cont-1", target: "#general", choices: ["a", "b", "c"] },
  });
  expect(output).toContain("answer the continuation");
  expect(output).toContain("coforge message continue cont-1 a");
  expect(output).toContain("coforge message continue cont-1 b");
  expect(output).toContain("the new content will NOT be sent");
  expect(output).toContain("coforge message continue cont-1 c");
  expect(output).not.toContain("message continue cont-1 d");
  // The explicit resend commands stay for script and JSON clients.
  expect(output).toContain("--send-draft");

  const offered = formatHeldSend("#general", {
    newMessageCount: 1,
    continuation: { id: "cont-2", target: "#general", choices: ["a", "b", "c", "d"] },
  });
  expect(offered).toContain("coforge message continue cont-2 d");
  expect(offered).toContain("--send-draft --anyway");
});
