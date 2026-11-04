import { describe, expect, test } from "bun:test";

import { updateNoticeLine } from "#src/update-notice";

const transport = (notice: string | null | Error) => ({
  computerUpdateNotice: async () => {
    if (notice instanceof Error) throw notice;
    return { ok: true as const, notice };
  },
});

describe("the Computer-update notice line", () => {
  test("a noticed release returns its line", async () => {
    expect(await updateNoticeLine(transport("newer release"), ["task", "list"])).toBe(
      "newer release",
    );
  });

  test("nothing to say returns nothing", async () => {
    expect(await updateNoticeLine(transport(null), ["task", "list"])).toBeUndefined();
  });

  test("`--json` output stays machine-only", async () => {
    expect(
      await updateNoticeLine(transport("newer release"), ["task", "list", "--json"]),
    ).toBeUndefined();
  });

  test("an unreachable daemon adds no line", async () => {
    expect(await updateNoticeLine(transport(new Error("down")), ["task", "list"])).toBeUndefined();
  });
});
