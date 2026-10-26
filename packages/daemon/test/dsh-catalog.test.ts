import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";
import { DshCatalogDiscovery } from "#src/code-agent/dsh/catalog";

const catalog: CodeAgentModelCatalog = {
  provider: "dsh",
  models: [
    {
      id: '["deepseek-official","native-model"]',
      displayName: "Native",
      description: "",
      modelProvider: "",
      reasoningEfforts: ["high"],
      defaultReasoning: "high",
      recommended: true,
    },
  ],
};

async function fixture(
  run: (options: {
    command: string[];
    cwd: string;
    environment: Record<string, string>;
  }) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "dsh-catalog-cache-"));
  try {
    await run({
      command: [process.execPath],
      cwd,
      environment: { HOME: cwd, DSH_HOME: join(cwd, "home"), DEEPSEEK_API_KEY: "dummy-one" },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("DSH cache reuses metadata only within one process and re-probes after an effective API key change", async () => {
  await fixture(async (options) => {
    let calls = 0;
    const discovery = new DshCatalogDiscovery(async () => {
      calls++;
      return catalog;
    });
    expect(await discovery.cached(options)).toBeUndefined();
    expect(await discovery.discover(options)).toEqual(catalog);
    expect(await discovery.discover(options)).toEqual(catalog);
    expect(calls).toBe(1);
    const changed = {
      ...options,
      environment: { ...options.environment, DEEPSEEK_API_KEY: "dummy-two" },
    };
    expect(await discovery.cached(changed)).toBeUndefined();
    await discovery.discover(changed);
    expect(calls).toBe(2);
    expect(await new DshCatalogDiscovery().cached(options)).toBeUndefined();
  });
});

test("a failed forced refresh preserves the old DSH cache and reports failure", async () => {
  await fixture(async (options) => {
    let fail = false;
    const discovery = new DshCatalogDiscovery(async () => {
      if (fail) throw new Error("private native diagnostic");
      return catalog;
    });
    await discovery.discover(options);
    fail = true;
    await expect(discovery.discover({ ...options, force: true })).rejects.toThrow(
      "DSH model catalog refresh failed",
    );
    expect(await discovery.cached(options)).toEqual(catalog);
    expect(await discovery.discover(options)).toEqual(catalog);
  });
});

test("DSH discovery notices credential/profile stat changes without reading credential contents", async () => {
  await fixture(async (options) => {
    let calls = 0;
    const discovery = new DshCatalogDiscovery(async () => {
      calls++;
      return catalog;
    });
    await discovery.discover(options);
    await mkdir(options.environment.DSH_HOME!, { recursive: true });
    await Bun.write(join(options.environment.DSH_HOME!, ".credentials.yaml"), "not valid YAML: [");
    expect(await discovery.cached(options)).toBeUndefined();
    await discovery.discover(options);
    await Bun.write(
      join(options.environment.DSH_HOME!, "profiles/acp/cordis.patch.yml"),
      "not parsed by CoForge",
    );
    await discovery.discover(options);
    expect(calls).toBe(3);
  });
});

test("DSH discovery owns a temporary cwd, retains the selected native home, and cleans success and failure", async () => {
  await fixture(async (options) => {
    let probeCwd = "";
    let fail = false;
    const discovery = new DshCatalogDiscovery(async (probe) => {
      probeCwd = probe.cwd;
      expect(probeCwd).not.toBe(options.cwd);
      expect((await stat(probeCwd)).isDirectory()).toBe(true);
      const nativeEnvironment = probe.host.buildEnvironment({
        agentWorkspaceDirectory: probe.cwd,
        instructions: "",
        environment: probe.environment,
      });
      expect(nativeEnvironment.PWD).toBe(probe.cwd);
      expect(probe.environment.DSH_HOME).toBe(join(options.cwd, "relative-home"));
      if (fail) throw new Error("native failure");
      // Native first boot materializes its profile. Cache the resulting state.
      await Bun.write(join(probe.environment.DSH_HOME!, "profiles/acp/cordis.yml"), "[]");
      return catalog;
    });
    const relative = {
      ...options,
      environment: { ...options.environment, DSH_HOME: "relative-home" },
    };
    await discovery.discover(relative);
    await expect(stat(probeCwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await discovery.cached(relative)).toEqual(catalog);
    fail = true;
    await expect(discovery.discover({ ...relative, force: true })).rejects.toThrow();
    await expect(stat(probeCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("concurrent ordinary DSH discovery shares one native session", async () => {
  await fixture(async (options) => {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const discovery = new DshCatalogDiscovery(async () => {
      calls++;
      started.resolve();
      await release.promise;
      return catalog;
    });
    const first = discovery.discover(options);
    await started.promise;
    const second = discovery.discover(options);
    release.resolve();
    expect(await first).toEqual(catalog);
    expect(await second).toEqual(catalog);
    expect(calls).toBe(1);
  });
});

test("DSH does not cache a catalog under credentials changed during the probe", async () => {
  await fixture(async (options) => {
    const credentials = join(options.environment.DSH_HOME!, ".credentials.yaml");
    await Bun.write(credentials, "before");
    const discovery = new DshCatalogDiscovery(async () => {
      await Bun.write(credentials, "after-credential-switch");
      return catalog;
    });
    await discovery.discover(options);
    expect(await discovery.cached(options)).toBeUndefined();
  });
});

test("native regeneration of cordis.yml does not invalidate DSH model metadata", async () => {
  await fixture(async (options) => {
    const generated = join(options.environment.DSH_HOME!, "profiles/acp/cordis.yml");
    await Bun.write(generated, "[]");
    let calls = 0;
    const discovery = new DshCatalogDiscovery(async () => {
      calls++;
      await Bun.write(generated, "# native generated root\n[]");
      return catalog;
    });
    await discovery.discover(options);
    await discovery.discover(options);
    expect(calls).toBe(1);
    expect(await discovery.cached(options)).toEqual(catalog);
  });
});

test("the selected DSH home includes the host's inherited environment", async () => {
  await fixture(async (options) => {
    const previous = Bun.env.DSH_HOME;
    const selected = join(options.cwd, "inherited-home");
    Bun.env.DSH_HOME = selected;
    const environment = { ...options.environment };
    delete environment.DSH_HOME;
    try {
      const discovery = new DshCatalogDiscovery(async (probe) => {
        expect(probe.environment.DSH_HOME).toBe(selected);
        return catalog;
      });
      await discovery.discover({ ...options, environment });
    } finally {
      if (previous === undefined) delete Bun.env.DSH_HOME;
      else Bun.env.DSH_HOME = previous;
    }
  });
});

async function firstBootOverlap(
  change?: "credential" | "profile" | "environment" | "failure" | "force",
) {
  await fixture(async (options) => {
    const profile = join(options.environment.DSH_HOME!, "profiles/acp/cordis.patch.yml");
    if (change === "profile") await Bun.write(profile, "initial patch");
    let calls = 0;
    let firstUnsettled = true;
    let overlapped = false;
    const materialized = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const discovery = new DshCatalogDiscovery(async (probe) => {
      const call = ++calls;
      if (call === 1) {
        if (change !== "profile")
          await Bun.write(join(probe.environment.DSH_HOME!, "profiles/acp/package.json"), "{}");
        materialized.resolve();
      } else overlapped = firstUnsettled;
      await release.promise;
      if (call === 1) firstUnsettled = false;
      if (change === "failure") throw new Error("native failed");
      return {
        ...catalog,
        models: catalog.models.map((model) => ({ ...model, id: `probe-${call}` })),
      };
    });
    const first = discovery.discover(options);
    // Observe rejection immediately, without changing the result under assertion.
    const firstResult = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await materialized.promise;
    let later = { ...options, force: false };
    if (change === "credential")
      await Bun.write(
        join(options.environment.DSH_HOME!, ".credentials.yaml"),
        "updated credentials",
      );
    if (change === "profile") await Bun.write(profile, "updated user patch");
    if (change === "environment")
      later = {
        ...later,
        environment: { ...options.environment, DEEPSEEK_API_KEY: "changed-key" },
      };
    if (change === "force") later = { ...later, force: true };
    expect(firstUnsettled).toBe(true);
    const second = discovery.discover(later);
    const secondResult = second.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      // Complete a public snapshot while the original exchange remains controlled and pending.
      // The profile already exists here; a later request must not open another native session.
      expect(await discovery.cached(later)).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      release.resolve();
      await Promise.all([firstResult, secondResult]);
    }
    expect(overlapped).toBe(false);
    const [a, b] = await Promise.all([firstResult, secondResult]);
    if (change === "failure") {
      expect(a).toHaveProperty("error");
      expect(b).toHaveProperty("error");
      expect(calls).toBe(1);
    } else {
      expect(a).toHaveProperty("value");
      expect(b).toHaveProperty("value");
      const changed = change !== undefined;
      expect(calls).toBe(changed ? 2 : 1);
      expect(await discovery.cached(later)).toMatchObject({
        models: [{ id: changed ? "probe-2" : "probe-1" }],
      });
    }
  });
}

test("ordinary calls during first profile materialization share one pending native discovery", async () => {
  await firstBootOverlap();
});
for (const change of ["credential", "profile", "environment"] as const) {
  test(`a ${change} change during materialization re-probes only after the pending discovery finishes`, async () => {
    await firstBootOverlap(change);
  });
}
test("waiting ordinary callers share a cold-start failure without automatically retrying", async () => {
  await firstBootOverlap("failure");
});

test("a forced refresh during first profile materialization waits and still runs its own probe", async () => {
  await firstBootOverlap("force");
});
