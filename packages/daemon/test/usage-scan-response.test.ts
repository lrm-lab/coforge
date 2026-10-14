import { describe, expect, test } from "bun:test";
import {
  UsageUnavailableError,
  UsageUnsupportedError,
  type UsageSnapshot,
} from "#src/code-agent/contract";
import {
  stampedUsage,
  usageScanFailure,
  usageScanReading,
  usageScanResult,
} from "#src/daemon-runtime/usage-scan-response";

const now = () => new Date("2026-10-12T01:00:00.000Z");
const fresh = { provider: "claude-code" } as unknown as UsageSnapshot;
const observed = {
  provider: "claude-code",
  collectedAt: "2026-10-12T00:30:00.000Z",
} as unknown as UsageSnapshot;
const decoded = (snapshotJson: Uint8Array | undefined) =>
  snapshotJson ? JSON.parse(new TextDecoder().decode(snapshotJson)) : undefined;

describe("usageScanResult", () => {
  test("is accepted exactly when it carries a snapshot", () => {
    expect(usageScanResult("unsupported")).toEqual({
      protocolMajor: 1,
      requestId: "",
      accepted: false,
      status: "unsupported",
    });
    const available = usageScanResult("available", fresh, "ok");
    expect(available.accepted).toBe(true);
    expect(decoded(available.snapshotJson)).toEqual(fresh);
    expect(available.message).toBe("ok");
  });
});

describe("stampedUsage", () => {
  test("stamps a fresh reading now, and keeps an observed snapshot's own time", () => {
    expect(stampedUsage(fresh, now).collectedAt).toBe("2026-10-12T01:00:00.000Z");
    expect(stampedUsage(observed, now)).toBe(observed);
  });
});

describe("usageScanReading", () => {
  test("answers a snapshot as available, and nothing as reauth", () => {
    const available = usageScanReading(fresh, now);
    expect(available.status).toBe("available");
    expect(decoded(available.snapshotJson).collectedAt).toBe("2026-10-12T01:00:00.000Z");
    expect(usageScanReading(undefined, now)).toMatchObject({
      status: "reauth",
      accepted: false,
      message: "Provider usage is unavailable",
    });
  });
});

describe("usageScanFailure", () => {
  test("an unsupported account wins over an observed snapshot, which is not even read", () => {
    let reads = 0;
    const answer = usageScanFailure(
      new UsageUnsupportedError(),
      () => {
        reads += 1;
        return observed;
      },
      now,
    );
    expect(answer).toMatchObject({
      status: "unsupported",
      accepted: false,
      message: "Usage scanning is unsupported for this account",
    });
    expect(reads).toBe(0);
  });

  test("any other failure falls back to the observed snapshot", () => {
    const answer = usageScanFailure(new Error("boom"), () => observed, now);
    expect(answer.status).toBe("available");
    expect(decoded(answer.snapshotJson)).toEqual(observed);
  });

  test("without one, an unavailable provider and any other failure differ", () => {
    expect(usageScanFailure(new UsageUnavailableError(), () => undefined, now)).toMatchObject({
      status: "unavailable",
      message: "Provider usage is unavailable",
    });
    expect(usageScanFailure(new Error("boom"), () => undefined, now)).toMatchObject({
      status: "error",
      message: "Usage scan failed",
    });
  });
});
