import { expect, test } from "bun:test";
import { attachPlatformMemoryBriefing } from "../src/agent-runtime/platform-memory-briefing";
import type { AgentInputQueue } from "../src/daemon-runtime/runtime-launch-intent";

const memoryId = "11111111-1111-4111-8111-111111111111";
function queue(): AgentInputQueue {
  return {
    closed: false,
    items: [
      {
        kind: "prompt",
        text: "Upgrade an old cloud computer",
        completion: { resolve() {}, reject() {} },
      },
    ],
  };
}
test("a fresh task receives bounded recalled reference before its original prompt", async () => {
  const input = queue();
  await attachPlatformMemoryBriefing(input, async (command) => {
    expect(command).toEqual({ operation: "search", query: "Upgrade an old cloud computer" });
    return {
      enabled: true,
      entries: [
        {
          id: memoryId,
          revision: 2,
          scope: "team",
          title: "Upgrade prerequisite",
          content: "Check the runtime activation script exists",
        },
      ],
    };
  });
  expect(input.items[0]?.kind).toBe("memory");
  expect(input.items[1]?.kind).toBe("prompt");
  const { index } = briefing(input);
  expect(index.remainingMemories).toBe(0);
  expect(index.remainingChars).toBe(0);
  expect(index.directory[0].preview).toBe("Check the runtime activation script exists");
});

test("empty recovery and whitespace input do not hide a later task", async () => {
  const input = queue();
  input.items.unshift(
    { kind: "recovery", context: {}, completion: { resolve() {}, reject() {} } },
    { kind: "prompt", text: "  ", completion: { resolve() {}, reject() {} } },
  );
  let query: string | undefined;
  await attachPlatformMemoryBriefing(input, async (command) => {
    if (command.operation === "search") query = command.query;
    return { enabled: true, entries: [] };
  });
  expect(query).toBe("Upgrade an old cloud computer");
});

test("a recovery with resume messages recalls against its saved task", async () => {
  const input = queue();
  input.items = [
    {
      kind: "recovery",
      context: {
        resumeMessages: [
          {
            messageId: "message",
            deliveryId: "delivery",
            conversationId: "conversation",
            sequence: 1,
            target: "#releases",
            latestSenderKind: "human",
            latestSenderHandle: "developer",
            latestSenderDescription: "Release owner",
            body: "Fix the release pipeline",
          },
        ],
      },
      completion: { resolve() {}, reject() {} },
    },
  ];
  let query: string | undefined;
  await attachPlatformMemoryBriefing(input, async (command) => {
    if (command.operation === "search") query = command.query;
    return { enabled: true, entries: [] };
  });
  expect(query).toBe("Fix the release pipeline");
});

function briefing(input: AgentInputQueue) {
  const item = input.items[0];
  if (item?.kind !== "memory") throw new Error("No recalled memory briefing");
  const index = JSON.parse(item.text.slice(item.text.indexOf("\n{") + 1));
  return { text: item.text, index };
}

test("long memories retain previews, a complete recall directory and exact unloaded counts", async () => {
  const input = queue();
  const entries = Array.from({ length: 8 }, (_, i) => ({
    id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    revision: 1,
    scope: "team",
    title: `Release note ${i}`,
    content: `Verified procedure ${i}: ${"release ".repeat(2000)}`,
  }));
  await attachPlatformMemoryBriefing(input, async () => ({ enabled: true, entries }));
  const { text, index } = briefing(input);
  expect(text.length).toBeLessThanOrEqual(6000);
  expect(text).toContain("coforge memory get --id <id>");
  expect(text).toContain("coforge memory list --page 1 --index");
  expect(index.recalledMatches).toBe(8);
  expect(index.remainingMemories).toBe(8);
  expect(index.directory.map((entry: { id: string }) => entry.id)).toEqual(
    entries.map((e) => e.id),
  );
  let remaining = 0;
  for (const [i, entry] of index.directory.entries()) {
    expect(entries[i]!.content.startsWith(entry.preview)).toBe(true);
    expect(entry.remainingChars).toBe(entries[i]!.content.length - entry.preview.length);
    remaining += entry.remainingChars;
  }
  expect(index.directory[0].preview.length).toBeGreaterThan(0);
  expect(index.directory.slice(5).every((entry: { preview: string }) => entry.preview === "")).toBe(
    true,
  );
  expect(index.remainingChars).toBe(remaining);
  expect(input.items[1]?.kind).toBe("prompt");
});

test("the whole briefing stays bounded for twenty escaped and multilingual memories", async () => {
  const input = queue();
  const entries = Array.from({ length: 20 }, (_, i) => ({
    id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    revision: 999,
    scope: "agent",
    title: `中文 title ${i} ${'"\\\n'.repeat(40)}`,
    content: `中文 🌱 ${'"\\\n'.repeat(4000)}`,
  }));
  await attachPlatformMemoryBriefing(input, async () => ({ enabled: true, entries }));
  const { text, index } = briefing(input);
  expect(text.length).toBeLessThanOrEqual(6000);
  expect(index.directory).toHaveLength(20);
  expect(index.remainingMemories).toBe(20);
  expect(text).toContain("at most 20");
});

test("a preview never cuts an emoji in half at its content boundary", async () => {
  const input = queue();
  await attachPlatformMemoryBriefing(input, async () => ({
    enabled: true,
    entries: [
      {
        id: memoryId,
        revision: 1,
        scope: "team",
        title: "Unicode",
        content: "a".repeat(999) + "🌱" + "tail",
      },
    ],
  }));
  const { index } = briefing(input);
  expect(index.directory[0].preview).toBe("a".repeat(999));
  expect(index.directory[0].remainingChars).toBe(6);
});
test("a memory outage or a queue closed during recall leaves the original task intact", async () => {
  const input = queue();
  await attachPlatformMemoryBriefing(input, async () => {
    throw new Error("offline");
  });
  expect(input.items).toHaveLength(1);
  await attachPlatformMemoryBriefing(input, async () => {
    input.closed = true;
    return { enabled: true, entries: [{ title: "x", content: "y" }] };
  });
  expect(input.items).toHaveLength(1);
});
