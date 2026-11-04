import { expect, test } from "bun:test";

import { artifactIdsInBody } from "#src/features/artifacts/artifact-link";

const a = "0b5a1f2e-1111-4a2b-9c3d-000000000001";
const b = "0b5a1f2e-2222-4a2b-9c3d-000000000002";

test("a body's document links, each once and in order", () => {
  const body = [
    `See https://coforge.cn/zh-CN/w/frank/channel/c1?doc=${a} and`,
    `[the copy](/w/frank/dm/d1?view=chat&doc=${b}) and again https://x.dev/w/frank/channel/c1?doc=${a}`,
  ].join("\n");
  expect(artifactIdsInBody(body)).toEqual([a, b]);
});

test("only this app's pages count, and a malformed id is no document", () => {
  expect(artifactIdsInBody(`https://example.com/page?doc=${a}`)).toEqual([]);
  expect(artifactIdsInBody("/w/frank/channel/c1?doc=not-a-uuid")).toEqual([]);
  expect(artifactIdsInBody(`/w/frank/channel/c1?mydoc=${a}`)).toEqual([]);
});

test("a long body shows at most three cards", () => {
  const ids = [1, 2, 3, 4].map((n) => `0b5a1f2e-1111-4a2b-9c3d-00000000000${n}`);
  const body = ids.map((id) => `/w/frank/channel/c1?doc=${id}`).join(" ");
  expect(artifactIdsInBody(body)).toEqual(ids.slice(0, 3));
});

test("an artifact's own page is its link, beside the conversation links before it", () => {
  const body = `Plan: https://coforge.cn/zh-CN/w/frank/artifacts/${a} and /w/frank/channel/c1?doc=${b}`;
  expect(artifactIdsInBody(body)).toEqual([a, b]);
  expect(artifactIdsInBody(`/w/frank/artifacts/not-a-uuid`)).toEqual([]);
});
