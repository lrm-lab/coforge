import { describe, expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { pageFillRequestFields, pageFillUrl, postPageFill } from "#src/server/conversations/page-fill.server";

const fields = [
  { id: "username", selector: "#user", input: "text" as const },
  { id: "password", selector: "#pass", input: "password" as const },
];

describe("page fill", () => {
  test("builds the agent screen address and refuses a foreign origin shape", () => {
    expect(pageFillUrl("https://desktop.example", "computer-1", "agent-1")).toBe(
      "https://desktop.example/desktop/computer-1/agent-1/fill",
    );
    expect(pageFillUrl("https://desktop.example/extra", "computer-1", "agent-1")).toBeUndefined();
    expect(pageFillUrl("https://user:pw@desktop.example", "computer-1", "agent-1")).toBeUndefined();
  });

  test("pairs values without leaving them out of the request, and rejects a blank password", () => {
    expect(pageFillRequestFields(fields, { username: "ada", password: "secret" })).toEqual([
      { id: "username", selector: "#user", value: "ada" },
      { id: "password", selector: "#pass", value: "secret" },
    ]);
    expect(() => pageFillRequestFields(fields, { username: "ada", password: "" })).toThrow(AppError);
    expect(() => pageFillRequestFields(fields, { username: "ada" })).toThrow(AppError);
  });

  test("the stored result is field names, and a closed browser is a typed error", async () => {
    const seen: { body?: string } = {};
    const filled = await postPageFill({
      origin: "https://desktop.example",
      computerId: "computer-1",
      agentId: "agent-1",
      fields,
      values: { username: "ada", password: "secret" },
      cookie: "session=1",
      fetchImpl: async (_url, init) => {
        seen.body = String(init?.body ?? "");
        return new Response(JSON.stringify({ filled: ["username", "password"] }), { status: 200 });
      },
    });
    expect(filled).toEqual({ filled: ["username", "password"] });
    expect(seen.body).toContain("secret");
    expect(JSON.stringify(filled)).not.toContain("secret");

    await expect(
      postPageFill({
        origin: "https://desktop.example",
        computerId: "computer-1",
        agentId: "agent-1",
        fields,
        values: { username: "ada", password: "secret" },
        cookie: "session=1",
        fetchImpl: async () => new Response(JSON.stringify({ error: "browser_not_open" }), { status: 409 }),
      }),
    ).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE", errorId: "page-fill-browser" });
  });
});
