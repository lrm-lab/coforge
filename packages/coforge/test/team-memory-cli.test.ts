import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import type { MessageTransport } from "#src/message-transport";

test("team writes are explicit, carry revisions and keep a stable retry identity", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const args = [
    "memory",
    "create",
    "--scope",
    "team",
    "--requestId",
    id,
    "--title",
    "preview domain",
    "--content",
    "Already purchased",
    "--source",
    "message 123",
    "--applicability",
    "workspace",
  ];
  expect(parseArgs(args)).toMatchObject({
    scope: "team",
    request: { operation: "create", requestId: id, kind: "fact" },
  });
  let calls = 0;
  const transport = {
    teamMemory: async () => {
      calls++;
      return {
        status: "review_required",
        entries: [],
        reviewRevision: 7,
        reviewToken: "00000000-0000-4000-8000-000000000099",
      };
    },
  } as unknown as MessageTransport;
  expect(await run(args, transport)).toContain(
    "--reviewToken 00000000-0000-4000-8000-000000000099",
  );
  expect(calls).toBe(1);
  expect(() => parseArgs([...args, "--workspaceId", id])).toThrow();
  expect(() => parseArgs(["memory", "search", "--scope", "unknown", "--query", "x"])).toThrow();
});

test("a history preview explains how to read one full revision", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const entry = {
    id,
    title: "Evidence",
    content: "Preview",
    source: "Message",
    applicability: "",
    kind: "fact",
    revision: 2,
    status: "active",
    authorAgentId: id,
    updatedAt: new Date().toISOString(),
  };
  const transport = {
    teamMemory: async () => ({ status: "ok", entries: [entry] }),
  } as unknown as MessageTransport;
  expect(await run(["memory", "history", "--scope", "team", "--id", id], transport)).toContain(
    `coforge memory get --scope team --id ${id} --revision 2`,
  );
  expect(
    parseArgs(["memory", "get", "--scope", "team", "--id", id, "--revision", "2"]),
  ).toMatchObject({ request: { operation: "get", id, revision: 2 } });
  for (const revision of ["0", "-1", "1.5", "invalid"])
    expect(() =>
      parseArgs(["memory", "get", "--scope", "team", "--id", id, "--revision", revision]),
    ).toThrow();
});
