import { expect, test } from "bun:test";
import {
  decodeMachineDiskStatusReport,
  decodeMachineMemoryStatusReport,
  encodeMachineDiskStatusReport,
  encodeMachineMemoryStatusReport,
  isMachineStatusReportable,
} from "#src/internal/machine-status-report";

const report = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-a",
  computerId: "computer-a",
  reportedAtMs: 1_700_000_000_000,
  availableBytes: 13_631_438_848,
  totalBytes: 34_359_738_368,
};

test("a disk and a memory report survive the wire unchanged", () => {
  expect(decodeMachineDiskStatusReport(encodeMachineDiskStatusReport(report))).toEqual(report);
  expect(decodeMachineMemoryStatusReport(encodeMachineMemoryStatusReport(report))).toEqual(report);
});

test("a sample that does not add up is refused, not sent", () => {
  expect(isMachineStatusReportable({ availableBytes: 1, totalBytes: 10 })).toBe(true);
  for (const sample of [
    { availableBytes: -1, totalBytes: 10 },
    { availableBytes: 11, totalBytes: 10 },
    { availableBytes: 1, totalBytes: 0 },
    { availableBytes: 1.5, totalBytes: 10 },
    { availableBytes: Number.NaN, totalBytes: 10 },
  ])
    expect(isMachineStatusReportable(sample)).toBe(false);
  expect(() =>
    encodeMachineDiskStatusReport({ ...report, availableBytes: 1, totalBytes: 0 }),
  ).toThrow("invalid machine status report");
});

test("a report missing its identity is refused", () => {
  expect(() => encodeMachineMemoryStatusReport({ ...report, computerId: " " })).toThrow(
    "invalid machine status report",
  );
  expect(() => decodeMachineMemoryStatusReport(new Uint8Array())).toThrow(
    "invalid machine status report",
  );
});
