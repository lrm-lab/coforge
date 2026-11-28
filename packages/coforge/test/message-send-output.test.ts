import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");
const credential = `sfp_${"a".repeat(43)}`;
const sendArgs = ["message", "send", "--target", "#general"];

async function runSend(flag: string, response: object) {
  const operations: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      operations.push(path);
      if (path.includes("guidance")) {
        return Response.json({ ok: true, guidance: "Clear an obsolete held send draft." });
      }
      if (path.includes("computer-update-notice")) {
        return Response.json({ ok: true, notice: "A newer Computer is available." });
      }
      return Response.json(response);
    },
  });
  try {
    const child = Bun.spawn([process.execPath, cli, ...sendArgs, flag], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        COFORGE_AGENT_CONTEXT: credential,
        COFORGE_AGENT_PROXY_URL: server.url.origin,
      },
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status, operations };
  } finally {
    await server.stop(true);
  }
}

test("a resumed send leaves its sent receipt last, with no generic notices", async () => {
  const output = await runSend("--send-draft", {
    accepted: true,
    messageId: "message-7",
    idempotencyKey: "draft-7",
    joinedChannel: "#general",
  });

  expect(output.status).toBe(0);
  expect(output.stdout).toContain("Joined #general.");
  expect(output.stdout.trimEnd().split("\n").at(-1)).toBe(
    "Message sent to #general. Message ID: message-7",
  );
  expect(output.stderr).toBe("");
  expect(output.operations).toEqual(["/api/agent/v1/messages"]);
});

test("a hold tells the agent that delivery did not occur and keeps output focused on the draft", async () => {
  const output = await runSend("--send-draft", {
    state: "held",
    decision: "local_hold",
    newMessageCount: 1,
  });

  expect(output.status).toBe(1);
  expect(output.stderr).toContain("Message held as draft; no target delivery occurred.");
  expect(output.stderr).not.toContain("A newer Computer");
  expect(output.stdout).toBe("");
});

test("discard reports an absent draft, and refuses to claim an unconfirmed discard", async () => {
  const missing = await runSend("--discard-draft", {
    accepted: true,
    discarded: false,
    clearedDraft: false,
  });
  expect(missing.status).toBe(0);
  expect(missing.stdout.trim()).toBe("No saved draft for #general; nothing was sent.");
  expect(missing.stderr).toBe("");

  const unconfirmed = await runSend("--discard-draft", { accepted: true });
  expect(unconfirmed.status).toBe(1);
  expect(unconfirmed.stdout).toBe("");
  expect(unconfirmed.stderr).toContain("DISCARD_DRAFT_UNCONFIRMED");
});

test("discard confirms either supported response field and rejects disagreement", async () => {
  const cleared = await runSend("--discard-draft", { accepted: true, clearedDraft: true });
  expect(cleared.status).toBe(0);
  expect(cleared.stdout.trim()).toBe("Draft for #general discarded; nothing was sent.");
  expect(cleared.stderr).toBe("");

  const contradictory = await runSend("--discard-draft", {
    accepted: true,
    discarded: true,
    clearedDraft: false,
  });
  expect(contradictory.status).toBe(1);
  expect(contradictory.stdout).toBe("");
  expect(contradictory.stderr).toContain("DISCARD_DRAFT_UNCONFIRMED");
});
