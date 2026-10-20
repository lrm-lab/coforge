import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyServers,
  parseListening,
  parsePs,
  type ServerFacts,
  STOP_GRACE_MS,
  stopExactly,
} from "../scripts/local-servers";

const script = join(import.meta.dir, "../scripts/local-servers.ts");
/** Room for a cold Bun start and a loaded machine. */
const MARGIN_MS = 3_000;
/** Injected into stopExactly so a test does not wait out STOP_GRACE_MS. */
const TEST_GRACE_MS = 500;
/** How long Bun may take to notice that a child of this test exited. */
const REAPED_WITHIN_MS = 500;
/** Above Linux's highest pid_max (2^22) and macOS's pid limit: no process can have it. */
const IMPOSSIBLE_PID = 2 ** 22 + 1;

// `ps -axo pid=,ppid=,rss=,etime=,command=` as macOS and Linux print it (macOS has no `etimes`).
const PS = [
  "  101     1  70000 4-15:06:40 /bin/bun --preload /x/gone/apps/web/scripts/exit-with-launcher.ts /x/gone/apps/web/.output/server/index.mjs",
  // A server from a deleted checkout without the launcher's preload: nothing says it was CoForge's.
  "  102     1  70000 4-15:06:40 /bin/bun /x/gone/apps/web/.output/server/index.mjs",
  // Another project's `apps/web`, and a Nuxt app (its build is `.output/server/index.mjs` too).
  "  103   150  70000   02:00:00 /bin/bun /x/other/apps/web/.output/server/index.mjs",
  "  104   150  70000   02:00:00 /bin/bun .output/server/index.mjs",
  "  200   199  60000      01:40 /bin/bun --preload /x/live/apps/web/scripts/exit-with-launcher.ts /x/live/apps/web/.output/server/index.mjs",
  "  199   150  10000      01:40 /bin/bun run ./scripts/start-server.ts",
  "  300   299  50000   01:23:20 /bin/bun --preload /x/live/apps/web/scripts/exit-with-launcher.ts --bun vite dev --port 8790",
  "  299   150  10000   01:23:20 /bin/bun ./scripts/dev-web-hmr.ts",
  // `bun --bun vite dev` is a thin wrapper; the Vite server it starts is a node child.
  "  301   300 900000   01:23:20 node /x/live/apps/web/node_modules/.bin/vite dev --port 8790",
  // dev:hmr runs Vite's own entry, so Vite is the one supervised Bun process.
  "  310   309 700000   02:00:00 /bin/bun --preload /x/live/apps/web/scripts/exit-with-launcher.ts --bun /x/node_modules/.bun/vite@8.2.2+a9b5/node_modules/vite/bin/vite.js dev --port 8792 --host 127.0.0.1 --strictPort",
  "  309   150  10000   02:00:00 /bin/bun /x/live/apps/web/scripts/dev-web-hmr.ts",
  // A node Vite whose Bun wrapper is gone, adopted by PID 1.
  "  700     1 800000 1-02:00:00 node /x/live/apps/web/node_modules/.bin/vite dev --port 8791",
  "  400   399  20000      00:10 /bin/bun /x/live/apps/web/.output/server/index.mjs",
  // `bun run start` in apps/web: the entry is relative, so the checkout is the cwd.
  "  450   150  30000      03:00 /bin/bun run .output/server/index.mjs",
  "  460     1  30000      03:00 /bin/bun .output/server/index.mjs",
  // Started from the repository root: the relative path is resolved against its cwd, not ours.
  "  470   150  30000      03:00 /bin/bun ./apps/web/.output/server/index.mjs",
  // Its launcher is alive, so it is still starting (waiting for Postgres, say), not stale.
  "  480   479  30000   02:00:00 /bin/bun --preload /x/live/apps/web/scripts/exit-with-launcher.ts /x/live/apps/web/.output/server/index.mjs",
  "  479   150  10000   02:00:00 /bin/bun run ./scripts/start-server.ts",
  "  500   150   9000   02:30:00 /bin/zsh -c echo apps/web/.output/server/index.mjs",
  "  600   150   9000   02:30:00 /usr/bin/vim notes.md",
  '  610   150   9000   02:30:00 /bin/zsh -c rg "vite dev" src',
  "  620   150   9000   02:30:00 less vite dev notes",
].join("\n");

test("parsePs reads every process's pid, parent, memory, age and command", () => {
  const rows = parsePs(PS);
  expect(rows.map((row) => row.pid)).toEqual([
    101, 102, 103, 104, 200, 199, 300, 299, 301, 310, 309, 700, 400, 450, 460, 470, 480, 479, 500,
    600, 610, 620,
  ]);
  expect(rows[0]).toEqual({
    pid: 101,
    ppid: 1,
    rssKb: 70000,
    ageSeconds: 400000,
    command:
      "/bin/bun --preload /x/gone/apps/web/scripts/exit-with-launcher.ts /x/gone/apps/web/.output/server/index.mjs",
  });
});

test("classifyServers names each local Web server, its launcher, and why it is stale", () => {
  const servers = classifyServers(parsePs(PS), {
    cwd: (pid) =>
      ({
        199: "/x/live/apps/web",
        299: "/x/live/apps/web",
        300: "/x/live/apps/web",
        104: "/x/nuxt/apps/web",
        450: "/x/live/apps/web",
        // Linux lsof marks a cwd that was removed, even if the path exists again: nothing there
        // says whose server it was.
        460: "/x/live/apps/web (deleted)",
        470: "/x/live",
        500: "/x/live/apps/web",
        610: "/x/live/apps/web",
        620: "/x/live/apps/web",
      })[pid],
    exists: (path) => !path.startsWith("/x/gone/"),
    webPackage: (webRoot) => (webRoot.startsWith("/x/live/") ? "@coforge/web" : "other"),
    listening: (pid) =>
      ({ 200: [8789], 301: [8790], 310: [8792], 450: [8788], 460: [8795], 470: [8796] })[pid] ?? [],
  });
  const live = { orphaned: false, stale: [] };
  expect(servers).toEqual([
    {
      pid: 101,
      pids: [101],
      launcher: undefined,
      kind: "nitro",
      webRoot: "/x/gone/apps/web",
      rssKb: 70000,
      ageSeconds: 400000,
      ports: [],
      orphaned: true,
      stale: ["checkout deleted", "not listening"],
    },
    {
      pid: 200,
      pids: [200],
      launcher: 199,
      kind: "nitro",
      webRoot: "/x/live/apps/web",
      rssKb: 60000,
      ageSeconds: 100,
      ports: [8789],
      ...live,
    },
    // The wrapper stands for its node Vite child: the child's port and memory count as its own.
    {
      pid: 300,
      pids: [300, 301],
      launcher: 299,
      kind: "vite",
      webRoot: "/x/live/apps/web",
      rssKb: 950000,
      ageSeconds: 5000,
      ports: [8790],
      ...live,
    },
    {
      pid: 310,
      pids: [310],
      launcher: 309,
      kind: "vite",
      webRoot: "/x/live/apps/web",
      rssKb: 700000,
      ageSeconds: 7200,
      ports: [8792],
      ...live,
    },
    {
      pid: 700,
      pids: [700],
      launcher: undefined,
      kind: "vite",
      webRoot: "/x/live/apps/web",
      rssKb: 800000,
      ageSeconds: 93600,
      ports: [],
      orphaned: true,
      stale: ["not listening"],
    },
    // Still starting: a server under a minute old is not judged by its ports yet.
    {
      pid: 400,
      pids: [400],
      launcher: undefined,
      kind: "nitro",
      webRoot: "/x/live/apps/web",
      rssKb: 20000,
      ageSeconds: 10,
      ports: [],
      ...live,
    },
    {
      pid: 450,
      pids: [450],
      launcher: undefined,
      kind: "nitro",
      webRoot: "/x/live/apps/web",
      rssKb: 30000,
      ageSeconds: 180,
      ports: [8788],
      ...live,
    },
    {
      pid: 470,
      pids: [470],
      launcher: undefined,
      kind: "nitro",
      webRoot: "/x/live/apps/web",
      rssKb: 30000,
      ageSeconds: 180,
      ports: [8796],
      ...live,
    },
    {
      pid: 480,
      pids: [480],
      launcher: 479,
      kind: "nitro",
      webRoot: "/x/live/apps/web",
      rssKb: 30000,
      ageSeconds: 7200,
      ports: [],
      ...live,
    },
  ]);
});

/** Facts for a live checkout of this package. */
const liveCheckout = (facts: Pick<ServerFacts, "cwd" | "listening">): ServerFacts => ({
  exists: () => true,
  webPackage: () => "@coforge/web",
  ...facts,
});

test("a shell or pager that merely names a server is not one", () => {
  const servers = classifyServers(
    parsePs(
      [
        '  610   150   9000   02:30:00 /bin/zsh -c rg "vite dev" src',
        "  620   150   9000   02:30:00 less vite dev notes",
        "  630   150   9000   02:30:00 /bin/zsh -c echo apps/web/.output/server/index.mjs",
      ].join("\n"),
    ),
    liveCheckout({ cwd: () => "/x/live/apps/web", listening: () => [] }),
  );
  expect(servers).toEqual([]);
});

test("a server row that is its own parent is classified, not walked forever", () => {
  const [server] = classifyServers(
    parsePs("    0     0   1000   02:00:00 /bin/bun /x/live/apps/web/.output/server/index.mjs"),
    liveCheckout({ cwd: () => undefined, listening: () => [8788] }),
  );
  expect(server).toMatchObject({ pid: 0, pids: [0], ports: [8788] });
});

test("an orphaned server that still listens is reported but not stale", () => {
  const [server] = classifyServers(
    parsePs("  800     1 500000   09:00:00 /bin/bun /x/live/apps/web/.output/server/index.mjs"),
    liveCheckout({ cwd: () => undefined, listening: () => [8788] }),
  );
  expect(server).toMatchObject({ pid: 800, orphaned: true, ports: [8788], stale: [] });
});

test("parseListening maps each pid to its listening ports from one machine-wide lsof", () => {
  // `lsof -iTCP -sTCP:LISTEN -P -n -Fpn`: a p line per process, then f and n lines per socket.
  const output = [
    "p968",
    "f16",
    "n*:8788",
    "f17",
    "n[::1]:8788",
    "p1084",
    "f11",
    "n127.0.0.1:7000",
    "",
  ];
  expect(parseListening(output.join("\n"))).toEqual(
    new Map([
      [968, [8788]],
      [1084, [7000]],
    ]),
  );
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(condition: () => boolean, withinMs: number) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(50);
  }
  return condition();
}

/** An idle Bun process of this test's own; `ignoreSigterm` makes it survive SIGTERM. */
async function idleProcess(ignoreSigterm = false) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `${ignoreSigterm ? 'process.on("SIGTERM", () => {});' : ""} console.log("ready"); setInterval(() => {}, 60_000);`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  // Ready once its SIGTERM handler is installed.
  await child.stdout.getReader().read();
  return child;
}

test(
  "stopExactly signals only pids still running their command, before SIGTERM and before SIGKILL",
  async () => {
    const children: Bun.Subprocess[] = [];
    try {
      const [exits, ignores, replaced, reused] = await Promise.all([
        idleProcess(),
        idleProcess(true),
        idleProcess(true),
        idleProcess(),
      ]);
      children.push(exits, ignores, replaced, reused);
      const commandsBySnapshot = [
        // Before SIGTERM, `reused`'s pid already runs something else.
        new Map([
          [exits.pid, "bun exits"],
          [IMPOSSIBLE_PID, "bun gone"],
          [ignores.pid, "bun ignores"],
          [replaced.pid, "bun replaced"],
          [reused.pid, "an unrelated process"],
        ]),
        // By the SIGKILL pass, `replaced`'s pid does.
        new Map([
          [ignores.pid, "bun ignores"],
          [replaced.pid, "an unrelated process"],
        ]),
      ];
      const signalled = await stopExactly(
        [
          { pid: exits.pid, command: "bun exits" },
          { pid: IMPOSSIBLE_PID, command: "bun gone" },
          { pid: ignores.pid, command: "bun ignores" },
          { pid: replaced.pid, command: "bun replaced" },
          { pid: reused.pid, command: "bun reused" },
        ],
        () => commandsBySnapshot.shift()!,
        TEST_GRACE_MS,
      );
      expect(signalled).toEqual([exits.pid, ignores.pid, replaced.pid]);
      expect(await waitFor(() => !alive(exits.pid) && !alive(ignores.pid), MARGIN_MS)).toBe(true);
      expect(alive(replaced.pid)).toBe(true);
      expect(alive(reused.pid)).toBe(true);
    } finally {
      for (const child of children) if (alive(child.pid)) child.kill("SIGKILL");
    }
  },
  TEST_GRACE_MS + 2 * MARGIN_MS,
);

/**
 * Runs `local-servers stop --stale` with `ps` and `lsof` replaced, so it can only ever see, and
 * stop, one process this test started: a Nitro server two hours old in an existing checkout.
 */
async function stopStaleWith(lsof: string) {
  const root = await mkdtemp(join(tmpdir(), "local-servers-"));
  let server: Bun.Subprocess | undefined;
  try {
    server = await idleProcess();
    const bin = join(root, "bin");
    await mkdir(bin);
    await mkdir(join(root, "apps/web"), { recursive: true });
    await writeFile(join(root, "apps/web/package.json"), JSON.stringify({ name: "@coforge/web" }));
    const row = `${server.pid} 1 1000 02:00:00 /bin/bun ${root}/apps/web/.output/server/index.mjs`;
    for (const [name, body] of [
      ["ps", `echo ${JSON.stringify(row)}`],
      ["lsof", lsof],
    ] as const) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    }
    const run = Bun.spawn([process.execPath, script, "stop", "--stale"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    // The command waits for what it stops to exit, so by now only Bun's reaping can be pending.
    const stopped = await Promise.race([
      server.exited.then(() => true),
      Bun.sleep(REAPED_WITHIN_MS).then(() => false),
    ]);
    return { exitCode, stdout, stderr, pid: server.pid, stopped };
  } finally {
    if (server && alive(server.pid)) server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

for (const [why, lsof] of [
  ["lsof fails", "exit 1"],
  ["lsof sees no listening socket on the machine", "exit 0"],
] as const) {
  test(
    `stop --stale stops nothing when ${why}`,
    async () => {
      const result = await stopStaleWith(lsof);
      expect(result.stderr).toContain("cannot see listening sockets; not stopping anything");
      expect(result.exitCode).toBe(1);
      expect(result.stopped).toBe(false);
    },
    STOP_GRACE_MS + 3 * MARGIN_MS,
  );
}

test(
  "stop --stale stops a server that listens on no port while others on the machine do",
  async () => {
    const result = await stopStaleWith(`printf 'p${IMPOSSIBLE_PID}\\nf5\\nn*:7000\\n'`);
    expect(result.stdout).toContain(`stopped ${result.pid}`);
    expect(result.exitCode).toBe(0);
    expect(result.stopped).toBe(true);
  },
  STOP_GRACE_MS + 3 * MARGIN_MS,
);
