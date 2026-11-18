import { expect, test } from "bun:test";
import { artifactIdOfWorkspaceRest } from "#src/features/artifacts/artifact-search";
import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";

const id = "01a1ec76-c1d6-73ab-9862-170b31d388fe";
const of = (path: string) => artifactIdOfWorkspaceRest(splitWorkspacePath(path)?.rest);

test("an artifact page path names its artifact, with or without locale, search or hash", () => {
  expect(of(`/w/lab/artifacts/${id}`)).toBe(id);
  expect(of(`/en/w/lab/artifacts/${id}?version=2`)).toBe(id);
  expect(of(`/w/lab/artifacts/${id}#top`)).toBe(id);
});

test("any other workspace path names no artifact", () => {
  expect(of("/w/lab/artifacts")).toBeUndefined();
  expect(of("/w/lab/artifacts/not-a-uuid")).toBeUndefined();
  expect(of(`/w/lab/channel/${id}`)).toBeUndefined();
  expect(of(`/w/lab/artifacts/${id}x`)).toBeUndefined();
  expect(of("/login")).toBeUndefined();
});
