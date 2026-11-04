import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("a notice never crashes the daemon", () => {
  test("a corrupt state file reads as empty and the next write covers it", async () => {
    const state = dir();
    try {
      writeFileSync(join(state, "computer-update-notice.json"), "{not json");
      const notice = new ComputerUpdateNotice(state, "0.1.25", () => Date.UTC(2026, 10, 4, 8));
      await notice.observeLatest("0.1.26");
      expect(await notice.takeNotice()).toContain("0.1.26");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a write failure rejects for its call site to catch, and take still answers", async () => {
    // A file where the state directory belongs makes every write fail ENOTDIR.
    const state = join(dir(), "not-a-directory");
    writeFileSync(state, "x");
    const notice = new ComputerUpdateNotice(state, "0.1.25", () => Date.UTC(2026, 10, 4, 8));
    // The class does not hide I/O: it rejects, and the runtime's call site catches + logs. The
    // daemon never dies from it — this test pins the rejection's shape, not a crash.
    await expect(notice.observeLatest("0.1.26")).rejects.toThrow();
    expect(await notice.takeNotice()).toBeNull();
  });
});

describe("the version comparison, not mere inequality, decides the notice", () => {
  test("a dev build ahead of the feed never warns backwards", async () => {
    const state = dir();
    try {
      const notice = new ComputerUpdateNotice(state, "0.1.26-dev.3", () =>
        Date.UTC(2026, 10, 4, 8),
      );
      await notice.observeLatest("0.1.25");
      expect(await notice.takeNotice()).toBeNull();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a feed version behind this Computer never warns", async () => {
    const state = dir();
    try {
      const notice = new ComputerUpdateNotice(state, "0.1.26", () => Date.UTC(2026, 10, 4, 8));
      await notice.observeLatest("0.1.25");
      expect(await notice.takeNotice()).toBeNull();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a version the feed mangles is ignored, not told", async () => {
    const state = dir();
    try {
      const notice = new ComputerUpdateNotice(state, "0.1.25", () => Date.UTC(2026, 10, 4, 8));
      await notice.observeLatest("not-a-version");
      expect(await notice.takeNotice()).toBeNull();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("the upgrade command it names exists: coforge-computer upgrade or the web page", async () => {
    const state = dir();
    try {
      const notice = new ComputerUpdateNotice(state, "0.1.25", () => Date.UTC(2026, 10, 4, 8));
      await notice.observeLatest("0.1.26");
      const line = await notice.takeNotice();
      expect(line).toContain("coforge-computer upgrade");
      expect(line).not.toContain("coforge computer upgrade");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
