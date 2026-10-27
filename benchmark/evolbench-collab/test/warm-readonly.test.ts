import { expect, test } from "bun:test";
import { shouldDrainEpisode } from "../src/drain-account";

test("warm episodes drain into their account by default (unchanged behaviour)", () => {
  expect(shouldDrainEpisode("warm", null, undefined, false)).toBe(true);
});

test("COFORGE_EVAL_WARM_READONLY keeps the warm arm from writing to the account it reads", () => {
  expect(shouldDrainEpisode("warm", null, undefined, true)).toBe(false);
});

test("frozen knowledge never drains the warm arm", () => {
  expect(shouldDrainEpisode("warm", { accountId: "a" }, undefined, false)).toBe(false);
});

test("cold episodes drain only into a shared corpus account, regardless of the warm flag", () => {
  expect(shouldDrainEpisode("cold", null, undefined, false)).toBe(false);
  expect(shouldDrainEpisode("cold", null, {}, false)).toBe(true);
  expect(shouldDrainEpisode("cold", null, {}, true)).toBe(true);
});

test("the flag is read from the environment when not passed", () => {
  const before = Bun.env.COFORGE_EVAL_WARM_READONLY;
  try {
    Bun.env.COFORGE_EVAL_WARM_READONLY = "1";
    expect(shouldDrainEpisode("warm", null, undefined)).toBe(false);
    delete Bun.env.COFORGE_EVAL_WARM_READONLY;
    expect(shouldDrainEpisode("warm", null, undefined)).toBe(true);
  } finally {
    if (before !== undefined) Bun.env.COFORGE_EVAL_WARM_READONLY = before;
  }
});
