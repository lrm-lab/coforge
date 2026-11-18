import { describe, expect, test } from "bun:test";

import { setupComputerOptions } from "#src/features/agents/profile-panel/setup-computers";

describe("setupComputerOptions", () => {
  test("keeps each computer's kind so the picker can tell cloud from local", () => {
    const options = setupComputerOptions(
      [
        { id: "a", kind: "cloud", name: "cloud-1", displayName: "Frank's Cloud", online: true },
        { id: "b", kind: "local", name: "s144", displayName: "", online: false },
      ],
      false,
    );
    expect(options).toEqual([
      { id: "a", kind: "cloud", name: "cloud-1", displayName: "Frank's Cloud", online: true },
      { id: "b", kind: "local", name: "s144", displayName: "s144", online: false },
    ]);
  });

  test("a weekly report assistant only offers the viewer's own computers", () => {
    const options = setupComputerOptions(
      [
        { id: "a", kind: "local", name: "mine", ownedByCurrentUser: true },
        { id: "b", kind: "cloud", name: "theirs", ownedByCurrentUser: false },
      ],
      true,
    );
    expect(options.map((option) => option.id)).toEqual(["a"]);
  });
});
