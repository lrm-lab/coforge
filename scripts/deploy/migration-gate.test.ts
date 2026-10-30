import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The migrate container's entry (scripts/migration-safety/migrate-deploy.sh): the gate runs first,
// and a failing gate means `migrate deploy` is never invoked. `bun` is a stub that records its calls.
const entry = join(import.meta.dir, "../migration-safety/migrate-deploy.sh");
const root = mkdtempSync(join(tmpdir(), "migration-gate-"));
const calls = join(root, "calls");

beforeAll(() => {
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/bun"),
    `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$*" in *--deploy*) exit "\${GATE_EXIT:-0}" ;; esac\n`,
  );
  chmodSync(join(root, "bin/bun"), 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(gateExit: number) {
  writeFileSync(calls, "");
  const result = Bun.spawnSync(["sh", entry], {
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
      GATE_EXIT: String(gateExit),
    },
  });
  return { code: result.exitCode, calls: readFileSync(calls, "utf8").trim().split("\n") };
}

describe("migrate container entry", () => {
  test("runs the gate, then the migrations", () => {
    expect(run(0)).toEqual({
      code: 0,
      calls: [
        "migration-safety/check-migration.ts --deploy",
        "node_modules/prisma/build/index.js migrate deploy",
      ],
    });
  });

  test.each([1, 2])("a gate that exits %d stops before any migration runs", (gateExit) => {
    expect(run(gateExit)).toEqual({
      code: gateExit,
      calls: ["migration-safety/check-migration.ts --deploy"],
    });
  });
});

describe("the deploy scripts", () => {
  test.each(["remote-deploy.sh", "blue-green-deploy.sh"])(
    "%s runs migrations only through the gate",
    (script) => {
      const text = readFileSync(join(import.meta.dir, script), "utf8");
      expect(text).toContain("sh migration-safety/migrate-deploy.sh");
      expect(text).not.toContain("migrate deploy' </dev/null");
    },
  );

  test("the image carries the runtime files of the checker, not its tests, and they are enough", async () => {
    const ignore = readFileSync(join(import.meta.dir, "../../.dockerignore"), "utf8");
    expect(ignore).toContain("scripts/migration-safety/*.test.ts");
    expect(ignore).toContain("scripts/migration-safety/*.integration.ts");
    // The files the image keeps, built on their own: every import must resolve among them.
    const source = join(import.meta.dir, "../migration-safety");
    const copy = mkdtempSync(join(root, "image-"));
    for (const name of readdirSync(source))
      if (name.endsWith(".ts") && !/\.(test|integration)\.ts$/.test(name))
        copyFileSync(join(source, name), join(copy, name));
    const built = await Bun.build({
      entrypoints: [join(copy, "check-migration.ts"), join(copy, "catalog-snapshot.ts")],
      target: "bun",
    });
    expect(built.logs.map(String)).toEqual([]);
    expect(built.success).toBe(true);
  });

  test("the web image carries the checker next to the migrations", () => {
    const dockerfile = readFileSync(join(import.meta.dir, "../../apps/web/Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "COPY --chown=bun:bun scripts/migration-safety .migrate/migration-safety",
    );
  });
});

// scripts/deploy/catalog-snapshot.sh on the host: a stub `docker` stands in for the migrate container.
describe("catalog-snapshot.sh", () => {
  const script = join(import.meta.dir, "catalog-snapshot.sh");
  const secretNames = [
    "authing_app_id",
    "authing_app_secret",
    "coforge_session_secret",
    "coforge_agent_credential_encryption_key",
    "coforge_web_push_public_key",
    "coforge_web_push_private_key",
    "coforge_file_delivery_key",
    "centrifugo_token_hmac_secret_key",
  ];

  function host(withEnv: boolean) {
    const dir = mkdtempSync(join(root, "host-"));
    mkdirSync(join(dir, "secrets"));
    for (const name of secretNames) writeFileSync(join(dir, "secrets", name), "x");
    writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
    if (withEnv) writeFileSync(join(dir, ".env"), "COFORGE_WEB_IMAGE=x\n");
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin/docker"),
      `#!/bin/sh\necho "$*" > "${dir}/docker-args"\necho '{"version":1}'\n`,
    );
    chmodSync(join(dir, "bin/docker"), 0o755);
    const result = Bun.spawnSync(
      [
        "bash",
        script,
        "--environment",
        "staging",
        "--compose-file",
        join(dir, "docker-compose.yml"),
        "--secrets-dir",
        join(dir, "secrets"),
      ],
      { env: { ...process.env, PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}` } },
    );
    return { dir, result };
  }

  test("runs the snapshot script in the migrate container and prints only its output", () => {
    const { dir, result } = host(true);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('{"version":1}\n');
    const args = readFileSync(join(dir, "docker-args"), "utf8");
    expect(args).toContain("compose -p coforge-staging -f ");
    expect(args).toContain(
      'run --rm --no-deps --entrypoint sh migrate -c cd .migrate && bun migration-safety/catalog-snapshot.ts "$1" sh staging',
    );
  });

  test("refuses a host where nothing has been deployed", () => {
    const { result } = host(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("nothing has been deployed here yet");
  });
});
