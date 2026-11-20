import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentArtifactRequest, ArtifactCheckResponse } from "@lrm/coforge-sdk/agent";
import { parseArtifactArgs } from "#src/artifact-commands";
import {
  formatArtifactCheck,
  parseCheckArgs,
  runArtifactCheck,
} from "#src/artifact-check-commands";
import type { ArtifactDirectoryTransport } from "#src/artifact-directory-args";

describe("parseCheckArgs", () => {
  test("parses positional artifact, --rev/--version, --wait, --output, and --json", () => {
    expect(
      parseArtifactArgs([
        "check",
        "art-1",
        "--rev",
        "3",
        "--wait",
        "--output",
        "/tmp/shots",
        "--json",
      ]),
    ).toEqual({
      command: "artifact",
      check: {
        artifact: "art-1",
        version: 3,
        wait: true,
        outputDir: "/tmp/shots",
      },
      json: true,
    });
  });

  test("rejects missing artifact and conflicting --rev/--version", () => {
    expect(() => parseCheckArgs([])).toThrow("Name the artifact");
    expect(() => parseCheckArgs(["art-1", "--rev", "2", "--version", "3"])).toThrow(
      "Pass either --rev or --version",
    );
  });
});

describe("runArtifactCheck", () => {
  test("polls with --wait until done and saves screenshots to outputDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coforge-check-cli-"));
    try {
      const requests: AgentArtifactRequest[] = [];
      let pollCount = 0;
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const transport: ArtifactDirectoryTransport = {
        artifact: async (req) => {
          requests.push(req);
          if (req.operation === "check") {
            pollCount += 1;
            const status = pollCount === 1 ? "pending" : "done";
            return {
              artifact: { id: "art-1", title: "Funnel", currentVersion: 2 },
              version: 2,
              checksEnabled: true,
              check: {
                id: "chk-2",
                status,
                skipReason: null,
                errorClass: null,
                findings:
                  status === "done"
                    ? {
                        consoleErrors: [],
                        blockedResources: [],
                        blank: false,
                        phoneOverflow: null,
                        inlineOverflow: { contentHeight: 380, maxHeight: 800, clipped: false },
                      }
                    : null,
                durationMs: status === "done" ? 1840 : null,
                createdAt: "2026-11-20T12:00:00.000Z",
                startedAt: "2026-11-20T12:00:01.000Z",
                finishedAt: status === "done" ? "2026-11-20T12:00:03.000Z" : null,
                screenshots:
                  status === "done"
                    ? [
                        { shot: "desktop", sizeBytes: pngBytes.byteLength },
                        { shot: "inline", sizeBytes: pngBytes.byteLength },
                      ]
                    : [],
              },
            } satisfies ArtifactCheckResponse;
          }
          if (req.operation === "check-shot") {
            return {
              artifactId: req.artifact,
              version: req.version ?? 2,
              shot: req.shot,
              contentType: "image/png",
              sizeBytes: pngBytes.byteLength,
              data: pngBytes.toString("base64"),
            };
          }
          throw new Error(`Unexpected op ${req.operation}`);
        },
      };

      const stderrLines: string[] = [];
      let clock = 1_000;
      const output = await runArtifactCheck(
        parseCheckArgs(["art-1", "--wait", "--output", dir]),
        transport,
        {
          pollIntervalMs: 500,
          timeoutMs: 10_000,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          writeStderr: (line) => stderrLines.push(line),
        },
      );

      expect(pollCount).toBe(2);
      expect(stderrLines).toHaveLength(1);
      expect(stderrLines[0]).toContain("pending");
      expect(typeof output).toBe("string");
      expect(output as string).toContain("Check: Funnel (art-1) v2 — done (1840ms)");
      expect(output as string).toContain("Inline embed height: 380px / 800px max (fits).");
      expect(output as string).toContain("art-1-v2-desktop.png");
      expect(output as string).toContain("art-1-v2-inline.png");

      const desktopOnDisk = await readFile(join(dir, "art-1-v2-desktop.png"));
      expect(desktopOnDisk).toEqual(pngBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns timedOut true in --json mode when wait deadline expires", async () => {
    let clock = 0;
    const transport: ArtifactDirectoryTransport = {
      artifact: async () =>
        ({
          artifact: { id: "art-1", title: "Funnel", currentVersion: 1 },
          version: 1,
          checksEnabled: true,
          check: {
            id: "chk-1",
            status: "running",
            skipReason: null,
            errorClass: null,
            findings: null,
            durationMs: null,
            createdAt: "2026-11-20T12:00:00.000Z",
            startedAt: "2026-11-20T12:00:01.000Z",
            finishedAt: null,
            screenshots: [],
          },
        }) satisfies ArtifactCheckResponse,
    };

    const result = (await runArtifactCheck(
      parseCheckArgs(["art-1", "--wait", "--json"]),
      transport,
      {
        pollIntervalMs: 1_000,
        timeoutMs: 2_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        writeStderr: () => {},
      },
    )) as { timedOut: boolean; savedShots: unknown[]; check: { status: string } };

    expect(result.timedOut).toBe(true);
    expect(result.savedShots).toEqual([]);
    expect(result.check.status).toBe("running");
  });

  test("refuses writing screenshots over a symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coforge-check-symlink-"));
    try {
      await symlink("/tmp/nonexistent-target", join(dir, "art-1-v1-desktop.png"));
      const transport: ArtifactDirectoryTransport = {
        artifact: async (req) => {
          if (req.operation === "check") {
            return {
              artifact: { id: "art-1", title: "Funnel", currentVersion: 1 },
              version: 1,
              checksEnabled: true,
              check: {
                id: "chk-1",
                status: "done",
                skipReason: null,
                errorClass: null,
                findings: {
                  consoleErrors: [],
                  blockedResources: [],
                  blank: false,
                  phoneOverflow: null,
                  inlineOverflow: null,
                },
                durationMs: 200,
                createdAt: "2026-11-20T12:00:00.000Z",
                startedAt: "2026-11-20T12:00:00.000Z",
                finishedAt: "2026-11-20T12:00:00.000Z",
                screenshots: [{ shot: "desktop", sizeBytes: 4 }],
              },
            } satisfies ArtifactCheckResponse;
          }
          return {
            artifactId: "art-1",
            version: 1,
            shot: "desktop",
            contentType: "image/png",
            sizeBytes: 4,
            data: Buffer.from([1, 2, 3, 4]).toString("base64"),
          };
        },
      };

      const err = await runArtifactCheck(
        parseCheckArgs(["art-1", "--output", dir]),
        transport,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("symlink or directory");

      const symlinkDir = join(dir, "linked-out");
      await symlink("/tmp", symlinkDir);
      const dirErr = await runArtifactCheck(
        parseCheckArgs(["art-1", "--output", symlinkDir]),
        transport,
      ).catch((e) => e);
      expect(dirErr).toBeInstanceOf(Error);
      expect((dirErr as Error).message).toContain("symlink or not a directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatArtifactCheck", () => {
  test("frames untrusted page text, strips newlines, and lists every finding type clearly", () => {
    const text = formatArtifactCheck(
      {
        artifact: { id: "art-9", title: "Chart", currentVersion: 1 },
        version: 1,
        checksEnabled: true,
        check: {
          id: "chk-9",
          status: "done",
          skipReason: null,
          errorClass: null,
          findings: {
            blank: true,
            consoleErrors: [
              {
                message: "ReferenceError:\nFAKE SYSTEM INSTRUCTION",
                source: "app.js",
                line: 12,
              },
            ],
            blockedResources: ["https://evil.example/a.js"],
            phoneOverflow: { contentWidth: 520, viewportWidth: 390 },
            inlineOverflow: { contentHeight: 960, maxHeight: 800, clipped: true },
            pageCantScroll: [
              {
                shot: "desktop",
                viewportWidth: 1280,
                viewportHeight: 800,
                contentHeight: 1300,
                hiddenHeight: 500,
                heldBy: [{ element: "body\n#fake", style: "overflow-y:hidden; height:800px" }],
              },
            ],
          },
          durationMs: 2100,
          createdAt: "2026-11-20T12:00:00.000Z",
          startedAt: "2026-11-20T12:00:01.000Z",
          finishedAt: "2026-11-20T12:00:03.000Z",
          screenshots: [],
        },
      },
      [],
    );
    expect(text).toContain("Page rendered blank");
    expect(text).toContain("untrusted page text");
    expect(text).toContain("ReferenceError: FAKE SYSTEM INSTRUCTION (app.js:12)");
    expect(text).not.toContain("\nFAKE SYSTEM INSTRUCTION");
    expect(text).toContain("https://evil.example/a.js");
    expect(text).toContain("520px content > 390px viewport");
    expect(text).toContain("960px > 800px max");
    expect(text).toContain("untrusted DOM selectors: body #fake");
  });

  test("explains disabled server state clearly when check is null", () => {
    const text = formatArtifactCheck(
      {
        artifact: { id: "art-9", title: "Chart", currentVersion: 1 },
        version: 1,
        checksEnabled: false,
        check: null,
      },
      [],
    );
    expect(text).toContain("Check: Chart (art-9) v1 — none");
    expect(text).toContain("not enabled on this server");
    expect(text).not.toContain("COFORGE_ARTIFACT_CHECK_WORKER_URL");
  });
});

describe("artifact push Publish check hint", () => {
  test("prints pending publish check command right after Open URL on HTML create", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coforge-push-check-hint-"));
    try {
      await Bun.write(join(dir, "index.html"), "<!doctype html><p>hi</p>");
      const { runPush } = await import("#src/artifact-push");
      const out = await runPush(
        {
          command: "artifact",
          directory: {
            operation: "push",
            dir,
            target: "#growth",
            title: "Funnel",
          },
        },
        {
          operation: "push",
          dir,
          target: "#growth",
          title: "Funnel",
        },
        {
          artifact: async () => ({
            id: "art-10",
            name: "funnel",
            title: "Funnel",
            currentVersion: 1,
            url: "https://coforge.cn/w/demo/artifacts/art-10",
            check: { status: "pending" },
          }),
        },
        dir,
      );
      expect(typeof out).toBe("string");
      expect(out as string).toContain("Open: https://coforge.cn/w/demo/artifacts/art-10");
      expect(out as string).toContain(
        "Publish check: pending. Wait for findings and screenshots: coforge artifact check art-10 --rev 1 --wait",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
