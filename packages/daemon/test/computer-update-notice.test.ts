import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ComputerUpdateNotice } from "#src/daemon-runtime/computer-update-notice";

const dir = () => mkdtempSync(join(tmpdir(), "coforge-update-notice-"));
const DAY_MS = 86_400_000;

describe("a newer Computer release is told once a day", () => {
  test("a newer release is told once that day and again the next", async () => {
    const state = dir();
    try {
      let now = Date.UTC(2026, 10, 4, 8);
      const notice = new ComputerUpdateNotice(state, "0.1.25", () => now);
      await notice.observeLatest("0.1.26");
      expect(await notice.takeNotice()).toContain("0.1.26");
      expect(await notice.takeNotice()).toBeNull();
      // A fresh daemon remembers the same day was already told.
      expect(await new ComputerUpdateNotice(state, "0.1.25", () => now).takeNotice()).toBeNull();
      now += DAY_MS;
      expect(await notice.takeNotice()).toContain("0.1.26");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("the release this Computer already runs says nothing", async () => {
    const state = dir();
    try {
      const notice = new ComputerUpdateNotice(state, "0.1.26", () => Date.UTC(2026, 10, 4, 8));
      await notice.observeLatest("0.1.26");
      expect(await notice.takeNotice()).toBeNull();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a Computer with no known version says nothing", async () => {
    const state = dir();
    try {
      const notice = new ComputerUpdateNotice(state, undefined, () => Date.UTC(2026, 10, 4, 8));
      await notice.observeLatest("0.1.26");
      expect(await notice.takeNotice()).toBeNull();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
