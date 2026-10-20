import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PYTEST_TIMEOUT_MS, runVerification } from "../src/verify";
import type { SkillsBenchTask } from "../src/types";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

type PytestCall = { cwd: string; args: string[]; pythonPath: string };

/**
 * Runs `body` with COFORGE_EVAL_PYTHON pointing at a stand-in for `python3 -m pytest`: it records
 * its working directory, arguments and PYTHONPATH (read back with `pytestCall`), prints `report`,
 * and exits with `exitCode`. A unit test must not depend on the host having pytest; the real
 * verifier is exercised by eval runs.
 */
async function withFakePytest(
  report: string,
  exitCode: number,
  body: (root: string, pytestCall: () => Promise<PytestCall>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sb-verify-"));
  const previous = process.env.COFORGE_EVAL_PYTHON;
  try {
    const record = join(root, "pytest-call.json");
    const python = join(root, "fake-python");
    await writeFile(join(root, "report.txt"), report, "utf8");
    await writeFile(
      python,
      [
        "#!/bin/sh",
        // The Bun running this test, so the stand-in does not depend on the child's PATH.
        `${JSON.stringify(process.execPath)} -e 'await Bun.write(process.argv[1], JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), pythonPath: process.env.PYTHONPATH }))' ${JSON.stringify(record)} "$@"`,
        `cat ${JSON.stringify(join(root, "report.txt"))}`,
        `exit ${exitCode}`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(python, 0o755);
    process.env.COFORGE_EVAL_PYTHON = python;
    await body(root, async () => JSON.parse(await readFile(record, "utf8")) as PytestCall);
  } finally {
    if (previous === undefined) delete process.env.COFORGE_EVAL_PYTHON;
    else process.env.COFORGE_EVAL_PYTHON = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "runVerification copies the agent workspace, flattens the tests and scores a passing pytest",
  async () => {
    await withFakePytest(
      "collected 1 items\ntest_outputs.py::test_product PASSED [100%]\n",
      0,
      async (root, pytestCall) => {
        const taskDir = join(root, "task");
        const agentWorkspace = join(root, "agent-workspace");
        const verifyBase = join(root, "verifybase");
        const verifyCopy = join(verifyBase, "verify");

        // A task whose test reads the agent's product via an absolute /root path and
        // imports a helper through /tests.
        await write(
          join(taskDir, "tests", "test_outputs.py"),
          [
            "import sys",
            "sys.path.insert(0, '/tests/src')",
            "from checker import read_product",
            "",
            "def test_product():",
            "    assert read_product('/root/output/result.txt') == 'done'",
            "",
          ].join("\n"),
        );
        await write(join(taskDir, "tests", "src", "checker.py"), "def read_product(path):\n");

        const task: SkillsBenchTask = {
          name: "fixture-task",
          dir: taskDir,
          instruction: "Produce /root/output/result.txt containing done.",
          skills: [],
          envFiles: [],
          testFiles: [
            { relPath: "test_outputs.py", absPath: join(taskDir, "tests", "test_outputs.py") },
            { relPath: "src/checker.py", absPath: join(taskDir, "tests", "src", "checker.py") },
          ],
        };

        // The agent "executed": it wrote the product at its workspace root.
        await write(join(agentWorkspace, "output", "result.txt"), "done\n");
        // Runtime state that must not leak into the verify copy.
        await write(join(agentWorkspace, ".builtin-runtime", "settings.json"), "{}\n");

        const verification = await runVerification({
          task,
          agentWorkspaceDir: agentWorkspace,
          verifyBaseDir: verifyBase,
        });

        expect(verification.verified).toBe(true);
        expect(verification.passed).toBe(true);
        expect(verification.testScore).toBe(1);
        expect(verification.error).toBeNull();
        expect(verification.missingExpectedPaths).toEqual([]);
        // The verify copy keeps the produced file but drops runtime dot-directories.
        expect(await Bun.file(join(verifyCopy, "output", "result.txt")).text()).toBe("done\n");
        expect(await Bun.file(join(verifyCopy, ".builtin-runtime", "settings.json")).exists()).toBe(
          false,
        );
        // The test file is flattened into the verify root; its helper rides along under tests/.
        expect(await Bun.file(join(verifyCopy, "test_outputs.py")).exists()).toBe(true);
        expect(await Bun.file(join(verifyCopy, "tests", "src", "checker.py")).exists()).toBe(true);
        // The flattened test has its absolute /tests and /root paths rewritten to the verify root.
        const flattened = await Bun.file(join(verifyCopy, "test_outputs.py")).text();
        expect(flattened).toContain("sys.path.insert(0, 'tests/src')");
        expect(flattened).toContain("read_product('output/result.txt')");

        expect(await pytestCall()).toEqual({
          // The child reports its cwd with symlinks resolved (/var is /private/var on macOS).
          cwd: await realpath(verifyCopy),
          args: [
            "-m",
            "pytest",
            "test_outputs.py",
            "-v",
            "--tb=short",
            "-W",
            "ignore::pytest.PytestCollectionWarning",
            `--junitxml=${join(verifyCopy, "logs", "verifier", "junit.xml")}`,
          ],
          pythonPath: verifyCopy,
        });
      },
    );
  },
  PYTEST_TIMEOUT_MS + 10_000,
);

test(
  "runVerification reports missing expected products and scores a failed pytest",
  async () => {
    await withFakePytest(
      [
        "collected 2 items",
        "test_outputs.py::test_present PASSED [ 50%]",
        "test_outputs.py::test_missing FAILED [100%]",
        "",
      ].join("\n"),
      1,
      async (root) => {
        const taskDir = join(root, "task");
        const agentWorkspace = join(root, "agent-workspace");

        await write(
          join(taskDir, "tests", "test_outputs.py"),
          [
            "def test_present():",
            "    pass",
            "",
            "def test_missing():",
            "    with open('/root/output/result.txt') as handle:",
            "        assert handle.read().strip() == 'done'",
            "",
          ].join("\n"),
        );

        const task: SkillsBenchTask = {
          name: "fixture-task-empty",
          dir: taskDir,
          instruction: "Produce /root/output/result.txt.",
          skills: [],
          envFiles: [],
          testFiles: [
            { relPath: "test_outputs.py", absPath: join(taskDir, "tests", "test_outputs.py") },
          ],
        };
        await mkdir(agentWorkspace, { recursive: true });

        const verification = await runVerification({
          task,
          agentWorkspaceDir: agentWorkspace,
          verifyBaseDir: join(root, "verifybase"),
        });

        // The failure branch: pytest's exit code fails the task, and the score is passed/collected.
        expect(verification.passed).toBe(false);
        expect(verification.error).toBe("pytest exit 1");
        expect(verification.testScore).toBe(0.5);
        expect(verification.missingExpectedPaths).toEqual(["output/result.txt"]);
      },
    );
  },
  PYTEST_TIMEOUT_MS + 10_000,
);
