import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const safeStdioScript = join(import.meta.dir, "safe-stdio.ts");

function runPtyHarness(
  mode: string,
  command: string[],
): { status: number; stdout: string; stderr: string } {
  const python = [
    "import os, pty, select, signal, subprocess, sys, time",
    "mode = sys.argv[1]",
    "cmd = sys.argv[2:]",
    "m, s = pty.openpty()",
    "try:",
    "    if mode == 'closed_stdin':",
    "        os.close(m); m = None",
    "        p = subprocess.Popen(cmd, stdin=s, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)",
    "        os.close(s); s = None",
    "    elif mode == 'closed_all':",
    "        os.close(m); m = None",
    "        p = subprocess.Popen(cmd, stdin=s, stdout=s, stderr=s, start_new_session=True, close_fds=True)",
    "        os.close(s); s = None",
    "    elif mode == 'live_pty':",
    "        p = subprocess.Popen(cmd, stdin=s, stdout=s, stderr=s, start_new_session=True, close_fds=True)",
    "        os.close(s); s = None",
    "    else:",
    "        raise ValueError(mode)",
    "    out = b''",
    "    t0 = time.monotonic()",
    "    while True:",
    "        if m is not None:",
    "            r, _, _ = select.select([m], [], [], 0.05)",
    "            if r:",
    "                try:",
    "                    chunk = os.read(m, 4096)",
    "                    if chunk: out += chunk",
    "                except OSError:",
    "                    pass",
    "        rc = p.poll()",
    "        if rc is not None:",
    "            if m is not None:",
    "                sys.stdout.buffer.write(out)",
    "            else:",
    "                if p.stdout: sys.stdout.buffer.write(p.stdout.read())",
    "                if p.stderr: sys.stderr.buffer.write(p.stderr.read())",
    "            sys.exit(rc)",
    "        if time.monotonic() - t0 > 10.0:",
    "            try: os.killpg(p.pid, signal.SIGKILL)",
    "            except ProcessLookupError: pass",
    "            p.wait()",
    "            sys.stderr.write('TIMEOUT\\n')",
    "            sys.exit(124)",
    "        time.sleep(0.01)",
    "finally:",
    "    for fd in (s, m):",
    "        if fd is not None:",
    "            try: os.close(fd)",
    "            except OSError: pass",
  ].join("\n");

  const result = Bun.spawnSync(["python3", "-c", python, mode, ...command], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("safe-stdio", () => {
  test("never treats non-TTY pipe fds as closed PTYs and respects detachStdin", () => {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { isClosedPtyFd, sanitizedStdio } from ${JSON.stringify(safeStdioScript)};
        console.log(JSON.stringify({
          closed: [isClosedPtyFd(0), isClosedPtyFd(1), isClosedPtyFd(2)],
          keep: sanitizedStdio(),
          detach: sanitizedStdio({ detachStdin: true }),
        }));`,
      ],
      { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      closed: [false, false, false],
      keep: ["inherit", "inherit", "inherit"],
      detach: ["ignore", "inherit", "inherit"],
    });
  });

  test("propagates non-zero exit codes from failing commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "coforge-safe-stdio-"));
    try {
      const badFile = join(dir, "unformatted.ts");
      writeFileSync(badFile, "export   const   x={a:1}\n");
      const result = Bun.spawnSync(
        [
          process.execPath,
          safeStdioScript,
          process.execPath,
          "x",
          "--bun",
          "oxfmt",
          "--check",
          badFile,
        ],
        { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (process.platform === "darwin" || process.platform === "linux") {
    test("detects closed-master PTYs and completes oxfmt cleanly without hanging or aborting", () => {
      const probeScript = `import { isClosedPtyFd, sanitizedStdio } from ${JSON.stringify(safeStdioScript)};
        console.log(JSON.stringify({
          closed: [isClosedPtyFd(0), isClosedPtyFd(1), isClosedPtyFd(2)],
          stdio: sanitizedStdio({ detachStdin: true }),
        }));`;

      const closedStdinProbe = runPtyHarness("closed_stdin", [process.execPath, "-e", probeScript]);
      expect(closedStdinProbe.status).toBe(0);
      expect(JSON.parse(closedStdinProbe.stdout.trim())).toEqual({
        closed: [true, false, false],
        stdio: ["ignore", "inherit", "inherit"],
      });

      const closedStdinFmt = runPtyHarness("closed_stdin", [
        process.execPath,
        safeStdioScript,
        process.execPath,
        "x",
        "--bun",
        "oxfmt",
        "--check",
        "scripts/ci/safe-stdio.ts",
      ]);
      expect(closedStdinFmt.status).toBe(0);

      const closedAllFmt = runPtyHarness("closed_all", [
        process.execPath,
        safeStdioScript,
        process.execPath,
        "x",
        "--bun",
        "oxfmt",
        "--check",
        "scripts/ci/safe-stdio.ts",
      ]);
      expect(closedAllFmt.status).toBe(0);

      const nodeCheck = runPtyHarness("closed_all", [
        process.execPath,
        safeStdioScript,
        "node",
        "-e",
        "process.stdin.isTTY; process.stdout.isTTY; process.stderr.isTTY;",
      ]);
      expect(nodeCheck.status).toBe(0);
    });

    test("leaves live TTY stdout/stderr inherited so interactive output stays intact", () => {
      const liveProbe = runPtyHarness("live_pty", [
        process.execPath,
        safeStdioScript,
        process.execPath,
        "-e",
        "console.log(JSON.stringify({ outTty: Boolean(process.stdout.isTTY), errTty: Boolean(process.stderr.isTTY), inTty: Boolean(process.stdin.isTTY) }));",
      ]);
      expect(liveProbe.status).toBe(0);
      expect(JSON.parse(liveProbe.stdout.trim())).toEqual({
        outTty: true,
        errTty: true,
        inTty: false,
      });
    });
  }
});

describe("oxfmt/oxlint package script runtime contract", () => {
  test("every package.json script invokes oxfmt and oxlint with --bun instead of bare node shims", () => {
    const manifests = [join(repoRoot, "package.json")];
    for (const parent of ["apps", "packages"]) {
      const dir = join(repoRoot, parent);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = join(dir, entry.name, "package.json");
        if (existsSync(pkgPath)) manifests.push(pkgPath);
      }
    }

    const violations: string[] = [];
    for (const manifest of manifests) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        for (const segment of script.split(/&&|\|\||;/)) {
          const trimmed = segment.trim();
          if (!/\b(?:oxfmt|oxlint)\b/.test(trimmed)) continue;
          if (!/\b(?:bun|bunx)\s+--bun\s+(?:oxfmt|oxlint)\b/.test(trimmed)) {
            violations.push(`${manifest}#${name}: ${trimmed}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
