import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openClaudeQuotaObservation } from "../dev/claude-quota-observation";

const approval = {
  environment: "non-production",
  runtimeId: crypto.randomUUID(),
  approverId: crypto.randomUUID(),
  approvedAt: new Date().toISOString(),
  computerGroup: crypto.randomUUID(),
  adapterVersion: "0.1.37-dev.2",
  cliVersion: "2.1.304",
} as const;

test("requires current approval bound to this launch", () => {
  expect(() =>
    openClaudeQuotaObservation({ ...approval, approvedAt: new Date(0).toISOString() }),
  ).toThrow();
  expect(() => openClaudeQuotaObservation({ ...approval, runtimeId: "" })).toThrow();
});

test("rotates private observations and removes the local capture on close", () => {
  const capture = openClaudeQuotaObservation(approval);
  try {
    const observedAt = new Date().toISOString();
    const fact = {
      type: "quota_window",
      window: "seven_day_sonnet",
      status: "rejected",
      resetsAt: null,
      observedAt,
      credentials: "synthetic-private",
    } as const;
    for (let i = 0; i < 800; i++) capture.optIn.observe(fact);
    expect(capture.optIn.runtimeId).toBe(approval.runtimeId);
    expect(statSync(capture.directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(capture.directory).sort()).toEqual([
      "approval.json",
      "observations.1.jsonl",
      "observations.jsonl",
    ]);
    const authorization = JSON.parse(
      readFileSync(join(capture.directory, "approval.json"), "utf8"),
    );
    expect(authorization).toMatchObject({
      runtimeId: approval.runtimeId,
      approverId: approval.approverId,
      approvedAt: approval.approvedAt,
    });
    for (const name of ["observations.1.jsonl", "observations.jsonl"]) {
      const path = join(capture.directory, name);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(path).size).toBeLessThanOrEqual(64 * 1024);
      const [line] = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(JSON.parse(line!)).toStrictEqual({
        observedAt,
        launch: authorization.launch,
        computerGroup: approval.computerGroup,
        accountGroup: "unknown",
        adapterVersion: approval.adapterVersion,
        cliVersion: approval.cliVersion,
        type: "quota_window",
        window: "seven_day_sonnet",
        status: "rejected",
        resetsAt: null,
      });
    }
  } finally {
    capture.close();
  }
  expect(() => statSync(capture.directory)).toThrow();
});
