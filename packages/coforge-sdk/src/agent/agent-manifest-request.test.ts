import { expect, test } from "bun:test";

import { buildActionRequest } from "./agent-manifest-request";

const action = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string) => ({
  endpoint: { method, path },
});

test("path params are percent-encoded per segment and removed from query and body", () => {
  const result = buildActionRequest(action("GET", "/notes/{id}/v/{n}"), {
    id: "a/b c?#",
    n: 3,
    q: "x y",
  });
  expect(result).toEqual({
    ok: true,
    path: "/notes/a%2Fb%20c%3F%23/v/3",
    query: [["q", "x y"]],
  });
  const post = buildActionRequest(action("PATCH", "/notes/{id}"), { id: "1", title: "t" });
  expect(post).toEqual({ ok: true, path: "/notes/1", query: [], body: { title: "t" } });
});

test("GET and DELETE send the rest as query, arrays as repeated pairs, null skipped", () => {
  const result = buildActionRequest(action("DELETE", "/n"), {
    tag: ["a", "b"],
    on: true,
    none: null,
  });
  expect(result).toEqual({
    ok: true,
    path: "/n",
    query: [
      ["tag", "a"],
      ["tag", "b"],
      ["on", "true"],
    ],
  });
  expect(buildActionRequest(action("GET", "/n"), { o: { a: 1 } }).ok).toBe(false);
});

test("POST and PUT send a JSON object body, even when empty", () => {
  expect(buildActionRequest(action("POST", "/n"), {})).toEqual({
    ok: true,
    path: "/n",
    query: [],
    body: {},
  });
  expect(buildActionRequest(action("PUT", "/n"), { a: { b: [1] } })).toMatchObject({
    body: { a: { b: [1] } },
  });
});

test("a missing, non-scalar, empty or dot path param is refused", () => {
  for (const input of [{}, { id: null }, { id: {} }, { id: "" }, { id: ".." }, { id: "." }])
    expect(buildActionRequest(action("GET", "/n/{id}"), input).ok).toBe(false);
  expect(buildActionRequest(action("GET", "/n"), [1]).ok).toBe(false);
  expect(buildActionRequest(action("GET", "/n/{toString}"), {}).ok).toBe(false);
});

test("a __proto__ input key stays an own body property", () => {
  const result = buildActionRequest(action("POST", "/n"), JSON.parse('{"__proto__": {"x": 1}}'));
  expect(result.ok && Object.keys(result.body ?? {})).toEqual(["__proto__"]);
});
