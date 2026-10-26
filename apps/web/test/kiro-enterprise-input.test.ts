import { expect, test } from "bun:test";
import { startRuntimeAuthLoginInputSchema } from "#src/features/computers/runtime-auth.schemas";
const input = {
  computerId: "computer-1",
  provider: "kiro" as const,
  kiroIdentityCenter: { startUrl: "https://example.awsapps.com/start", region: "us-east-1" },
};
test("enterprise login validates both target fields at the public server-function seam", () => {
  expect(startRuntimeAuthLoginInputSchema.parse(input)).toEqual(input);
  expect(
    startRuntimeAuthLoginInputSchema.safeParse({ ...input, kiroIdentityCenter: undefined }).success,
  ).toBe(false);
  expect(startRuntimeAuthLoginInputSchema.safeParse({ ...input, provider: "codex" }).success).toBe(
    false,
  );
  expect(
    startRuntimeAuthLoginInputSchema.safeParse({
      ...input,
      kiroIdentityCenter: { ...input.kiroIdentityCenter, region: "x\nquit" },
    }).success,
  ).toBe(false);
});
