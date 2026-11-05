import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSupervisorRecord, writeSupervisorRecord } from "@lrm/coforge-daemon";
import { recordExternalSupervisor } from "#src/cli/foreground-supervisor";

const record = {
  kind: "systemd" as const,
  scope: "user" as const,
  unit: "coforge-daemon.service",
  invocationId: "inv",
  pid: 7,
  recordedAt: "2026-11-05T00:00:00.000Z",
};
const dir = () => mkdtemp(join(tmpdir(), "fg-supervisor-"));

test("not declared: nothing is recorded or asked", async () => {
  const d = await dir();
  let asked = false;
  await recordExternalSupervisor(d, () => {}, {
    env: {},
    detect: async () => {
      asked = true;
      return record;
    },
  });
  expect(asked).toBe(false);
  expect(await readSupervisorRecord(d)).toBeNull();
});

test("declared and verified: the unit is recorded", async () => {
  const d = await dir();
  await recordExternalSupervisor(d, () => {}, {
    env: { COFORGE_COMPUTER_EXTERNAL_SUPERVISOR: "1" },
    detect: async () => record,
  });
  expect(await readSupervisorRecord(d)).toEqual(record);
});

test("declared but not verifiable: a stale record goes and the person is told", async () => {
  const d = await dir();
  await writeSupervisorRecord(d, record);
  const warnings: string[] = [];
  await recordExternalSupervisor(d, (line) => warnings.push(line), {
    env: { COFORGE_COMPUTER_EXTERNAL_SUPERVISOR: "true" },
    detect: async () => null,
  });
  expect(await readSupervisorRecord(d)).toBeNull();
  expect(warnings.join("\n")).toContain("not the main process of a systemd service");
});

test("INVOCATION_ID alone, without the switch, is not an external supervisor", async () => {
  const d = await dir();
  let asked = false;
  await recordExternalSupervisor(d, () => {}, {
    env: { INVOCATION_ID: "inv" },
    detect: async () => {
      asked = true;
      return record;
    },
  });
  expect(asked).toBe(false);
  expect(await readSupervisorRecord(d)).toBeNull();
});
