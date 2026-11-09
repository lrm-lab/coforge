import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { memoryAgentGateFrom } from "./memory-agent-gate.server";
import { enableMemoryAgentForWorkspace } from "./default-memory-agent.server";
import { createWorkspaceMemoryProfiles } from "./profiles";
import { createInMemoryWorkspaceMemoryProfileStore } from "./stores";

/**
 * The Memory Agent answers to two switches (task #6): the deployment's
 * `OPENVIKING_PROTOTYPE_ENABLED` and the Workspace's own `memoryAgent` experiment. They combine
 * into the one gate the agent already had, so "off" is the gate saying no — there is no second
 * disabled state to keep in step.
 */
test("the deployment switch and the workspace switch are both required", () => {
  expect(memoryAgentGateFrom(false, false)).toEqual({ prototypeEnabled: false });
  expect(memoryAgentGateFrom(false, true)).toEqual({ prototypeEnabled: false });
  expect(memoryAgentGateFrom(true, false)).toEqual({ prototypeEnabled: false });
  expect(memoryAgentGateFrom(true, true)).toEqual({ prototypeEnabled: true });
});

test("a workspace that switched the experiment off is refused, even when the deployment allows it", async () => {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const profiles = createWorkspaceMemoryProfiles({
    store,
    // Two Workspaces, two answers: only the one that switched it on may provision.
    gate: async (workspaceId) => memoryAgentGateFrom(true, workspaceId === "ws-on"),
  });
  const on = await profiles.selectDesired({
    workspaceId: "ws-on",
    desired: "openviking",
    at: new Date(),
  });
  expect(on.ok).toBe(true);
  const off = await profiles.selectDesired({
    workspaceId: "ws-off",
    desired: "openviking",
    at: new Date(),
  });
  expect(off.ok).toBe(false);
  if (!off.ok) expect(off.failure.code).toBe("prototype_disabled");
  // Nothing was written for the Workspace that said no: the profile is still the default one.
  expect((await profiles.get("ws-off")).desired).toBe("off");
});

/** A fifth creation path that forgot the gate would quietly bring the Agent back for a Workspace
 * that switched the experiment off, which is the one thing "off" may never do (task #6). Every
 * caller of the two attach functions resolves a gate first, and the enable path is the only one
 * allowed to force it open.
 */
test("every path that creates the Memory Agent decides through the gate", async () => {
  const roots = ["apps/web/src/server", "apps/web/src/features"];
  const callers: { file: string; line: string }[] = [];
  for (const root of roots) {
    const directory = join(process.cwd(), "..", "..", root);
    for await (const path of new Bun.Glob("**/*.ts").scan(directory)) {
      if (/\.(test|server\.test)\.ts$/.test(path)) continue;
      const text = await readFile(join(directory, path), "utf8");
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (!/attachDefaultMemoryAgent\(|attachDefaultMemoryAgentToGeneral\(/.test(line)) return;
        if (/export async function/.test(line)) return;
        // The gate is the call's own argument, so it sits in the call's few lines, not this one.
        callers.push({ file: path, line: lines.slice(index, index + 8).join("\n") });
      });
    }
  }
  expect(callers.length).toBeGreaterThan(0);
  for (const caller of callers) {
    // `attachDefaultMemoryAgent` takes its gate as a required argument (TypeScript holds that), so
    // every one of its callers resolves one; `attachDefaultMemoryAgentToGeneral` resolves the
    // Workspace's own answer unless a caller is about to make it one.
    const resolvesGate =
      /attachDefaultMemoryAgentToGeneral\(/.test(caller.line) ||
      /memoryAgentGate|enableMemoryAgentForWorkspace|gate: gate/.test(caller.line);
    expect(resolvesGate, `${caller.file}: ${caller.line}`).toBe(true);
  }
});

/** Switching the experiment on while the deployment's master switch is off creates nothing: the
 * choice is stored and arms the Workspace, and the gate still says no. */
test("enabling the experiment under a closed master switch creates no Agent", async () => {
  const previous = Bun.env.OPENVIKING_PROTOTYPE_ENABLED;
  Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "false";
  try {
    // Any database call would throw on this stand-in: the point is that none is made.
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the database was not to be read");
        },
      },
    );
    expect(await enableMemoryAgentForWorkspace(db as never, "ws", "user")).toBeUndefined();
  } finally {
    if (previous === undefined) delete Bun.env.OPENVIKING_PROTOTYPE_ENABLED;
    else Bun.env.OPENVIKING_PROTOTYPE_ENABLED = previous;
  }
});
