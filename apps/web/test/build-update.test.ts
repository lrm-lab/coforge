import { expect, test } from "bun:test";

import {
  buildUpdateStateAfterProbe,
  createBuildUpdateController,
  hasUnsavedTemporaryState,
  isChunkLoadError,
  registerUnsavedTemporaryState,
} from "#src/features/updates/build-update";

test("a server version that differs from the build value detects an update", () => {
  expect(buildUpdateStateAfterProbe({ updateDetected: false }, "old", "new")).toEqual({
    updateDetected: true,
  });
});

test("an update stays detected when a rolling deployment answers with the old version again", () => {
  const detected = buildUpdateStateAfterProbe({ updateDetected: false }, "old", "new");
  expect(buildUpdateStateAfterProbe(detected, "old", "old")).toEqual({ updateDetected: true });
});

test("a matching server version does not detect an update", () => {
  expect(buildUpdateStateAfterProbe({ updateDetected: false }, "same", "same")).toEqual({
    updateDetected: false,
  });
});

test("chunk and dynamic import failures are update errors, but ordinary errors are not", () => {
  expect(isChunkLoadError(new Error("Failed to fetch dynamically imported module"))).toBe(true);
  expect(isChunkLoadError(new Error("Loading chunk 7 failed"))).toBe(true);
  expect(isChunkLoadError(new Error("chunk upload failed"))).toBe(false);
  expect(isChunkLoadError(new Error("Request failed"))).toBe(false);
});

test("unsaved temporary state is registered and released by its owner", () => {
  expect(hasUnsavedTemporaryState()).toBe(false);
  const release = registerUnsavedTemporaryState(true);
  expect(hasUnsavedTemporaryState()).toBe(true);
  release();
  expect(hasUnsavedTemporaryState()).toBe(false);
});

test("a chunk error on the same build suppresses the update notice", async () => {
  let fetchCount = 0;
  let notifyCount = 0;
  const controller = createBuildUpdateController({
    clientBuildId: "build-v1",
    fetchBuildId: async () => {
      fetchCount += 1;
      return "build-v1";
    },
    onUpdateDetected: () => {
      notifyCount += 1;
    },
  });

  expect(await controller.handleChunkLoadError()).toBe("same");
  expect(fetchCount).toBe(1);
  expect(notifyCount).toBe(0);
  expect(controller.isUpdateDetected()).toBe(false);
});

test("a chunk error after a real deployment confirms the new build and notifies once", async () => {
  let notifyCount = 0;
  const controller = createBuildUpdateController({
    clientBuildId: "build-v1",
    fetchBuildId: async () => "build-v2",
    onUpdateDetected: () => {
      notifyCount += 1;
    },
  });

  expect(await controller.handleChunkLoadError()).toBe("updated");
  expect(await controller.handleChunkLoadError()).toBe("updated");
  expect(notifyCount).toBe(1);
  expect(controller.isUpdateDetected()).toBe(true);
});

test("offline or an unreachable build-id probe suppresses the update notice and recovers later", async () => {
  let offline = true;
  let serverBuildId: string | undefined = undefined;
  let fetchCount = 0;
  let notifyCount = 0;
  const controller = createBuildUpdateController({
    clientBuildId: "build-v1",
    isOffline: () => offline,
    fetchBuildId: async () => {
      fetchCount += 1;
      return serverBuildId;
    },
    onUpdateDetected: () => {
      notifyCount += 1;
    },
  });

  expect(await controller.handleChunkLoadError()).toBe("unavailable");
  expect(fetchCount).toBe(0);
  expect(notifyCount).toBe(0);

  offline = false;
  serverBuildId = undefined;
  expect(await controller.handleChunkLoadError()).toBe("unavailable");
  expect(fetchCount).toBe(1);
  expect(notifyCount).toBe(0);

  serverBuildId = "build-v2";
  expect(await controller.probe()).toBe("updated");
  expect(fetchCount).toBe(2);
  expect(notifyCount).toBe(1);
});

test("concurrent active probing and chunk errors share one in-flight probe and notify once", async () => {
  let fetchCount = 0;
  let notifyCount = 0;
  let resolveFetch: ((value: string | undefined) => void) | undefined;
  const controller = createBuildUpdateController({
    clientBuildId: "build-v1",
    fetchBuildId: () => {
      fetchCount += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
    onUpdateDetected: () => {
      notifyCount += 1;
    },
  });

  const activeProbe = controller.probe();
  const chunkError1 = controller.handleChunkLoadError();
  const chunkError2 = controller.handleChunkLoadError();
  expect(fetchCount).toBe(1);

  resolveFetch?.("build-v2");
  expect(await Promise.all([activeProbe, chunkError1, chunkError2])).toEqual([
    "updated",
    "updated",
    "updated",
  ]);
  expect(fetchCount).toBe(1);
  expect(notifyCount).toBe(1);
});

test("development builds skip build-id probing on chunk errors", async () => {
  let fetchCount = 0;
  let notifyCount = 0;
  const controller = createBuildUpdateController({
    clientBuildId: "development",
    fetchBuildId: async () => {
      fetchCount += 1;
      return "build-v2";
    },
    onUpdateDetected: () => {
      notifyCount += 1;
    },
  });

  expect(await controller.handleChunkLoadError()).toBe("skipped");
  expect(fetchCount).toBe(0);
  expect(notifyCount).toBe(0);
});
