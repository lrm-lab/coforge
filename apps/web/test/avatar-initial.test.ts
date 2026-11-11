import { describe, expect, test } from "bun:test";
import { avatarInitial } from "#src/lib/avatar-tone";

describe("avatarInitial", () => {
  test("is a name's first letter, upper-cased, past a handle's @", () => {
    expect(avatarInitial("frank")).toBe("F");
    expect(avatarInitial("@coder")).toBe("C");
    expect(avatarInitial("  设计评审")).toBe("设");
  });

  test("passes over a leading emoji to the first letter, whole (task #86)", () => {
    expect(avatarInitial("🦊 Fox")).toBe("F");
    expect(avatarInitial("👩‍💻dev")).toBe("D");
    expect(avatarInitial("🇨🇳 中国")).toBe("中");
  });

  test("keeps a letter with its combining mark", () => {
    expect(avatarInitial("émile")).toBe("É");
  });

  test("a name of emoji alone shows its first, whole; an empty name a ?", () => {
    expect(avatarInitial("🦊")).toBe("🦊");
    expect(avatarInitial("👩‍💻🚀")).toBe("👩‍💻");
    expect(avatarInitial("  ")).toBe("?");
  });
});
