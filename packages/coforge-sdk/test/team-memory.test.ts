import { expect, test } from "bun:test";
import { decodeTeamMemoryCommand, decodeTeamMemoryResult } from "../src/agent/team-memory";

const id = "00000000-0000-4000-8000-000000000001";
test("memory decoders accept legacy Agents and real human attribution but never unauthored entries", () => {
  const entry = {
    id,
    authorAgentId: id,
    title: "Decision",
    content: "Verified",
    source: "Member",
    kind: "decision",
    applicability: "",
    status: "active",
    revision: 1,
    updatedAt: "2026-11-17T00:00:00Z",
  };
  expect(decodeTeamMemoryResult({ status: "ok", entries: [entry] }).entries[0]?.authorAgentId).toBe(
    id,
  );
  expect(
    decodeTeamMemoryResult({
      status: "ok",
      entries: [{ ...entry, authorAgentId: null, authorUserId: id }],
    }).entries[0]?.authorUserId,
  ).toBe(id);
  expect(() =>
    decodeTeamMemoryResult({ status: "ok", entries: [{ ...entry, authorAgentId: null }] }),
  ).toThrow();
  expect(() =>
    decodeTeamMemoryResult({ status: "ok", entries: [{ ...entry, authorUserId: id }] }),
  ).toThrow();
  expect(() =>
    decodeTeamMemoryResult({
      status: "ok",
      entries: [{ ...entry, projectId: "another workspace" }],
    }),
  ).toThrow();
});
test("project and protection fields are bounded and survive command decoding", () => {
  expect(decodeTeamMemoryCommand({ operation: "list", projectId: id })).toMatchObject({
    projectId: id,
  });
  expect(
    decodeTeamMemoryCommand({
      operation: "prepare",
      title: "Fact",
      content: "Confirmed",
      source: "Member",
      kind: "fact",
      applicability: "",
      projectId: null,
      pinned: true,
    }),
  ).toMatchObject({ projectId: null, pinned: true });
  expect(() => decodeTeamMemoryCommand({ operation: "projects", offset: 100001 })).toThrow();
  expect(() =>
    decodeTeamMemoryCommand({
      operation: "project-create",
      name: "Project",
      slug: "../other",
      description: "",
    }),
  ).toThrow();
  expect(() => decodeTeamMemoryCommand({ operation: "projects", workspaceId: id })).toThrow();
});

test("structured team memory evidence and version relationships survive decoding", () => {
  const draft = {
    operation: "prepare",
    title: "Migration",
    content: "Approved",
    source: "Task acceptance",
    kind: "decision",
    applicability: "production",
    evidence: [{ kind: "task", id, revision: 2 }],
    relations: [{ kind: "supersedes", id, revision: 1 }],
    effectiveAt: "2026-11-18T00:00:00Z",
  };
  expect(decodeTeamMemoryCommand(draft)).toMatchObject({
    evidence: draft.evidence,
    relations: draft.relations,
    effectiveAt: "2026-11-18T00:00:00.000Z",
  });
  expect(() =>
    decodeTeamMemoryCommand({ ...draft, evidence: [{ kind: "message", id: "bad" }] }),
  ).toThrow("invalid_memory_evidence");
  expect(() =>
    decodeTeamMemoryCommand({ ...draft, relations: [...draft.relations, ...draft.relations] }),
  ).toThrow("invalid_memory_relations");
});
