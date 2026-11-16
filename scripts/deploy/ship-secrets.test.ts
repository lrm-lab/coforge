import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const script = new URL("./ship-secrets.sh", import.meta.url).pathname;

async function ship(args: string[], values: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "coforge-ship-secrets-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(
      join(root, "bin/ssh"),
      `#!/bin/bash
echo "$*" > "$FIXTURE_ROOT/ssh-args"
cat > "$FIXTURE_ROOT/payload.tgz"
`,
      { mode: 0o700 },
    );
    const proc = Bun.spawn(["bash", script, ...args], {
      env: {
        ...Bun.env,
        PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
        FIXTURE_ROOT: root,
        SSH_DIR: "/ssh-dir",
        DEPLOY_SSH_USER: "deploy",
        DEPLOY_SSH_HOST: "host.example.test",
        ...values,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const shipped = await Bun.file(join(root, "payload.tgz")).exists();
    const files: Record<string, { value: string; mode: number }> = {};
    let sshArgs = "";
    if (shipped) {
      const out = join(root, "out");
      await mkdir(out);
      const tar = Bun.spawn(["tar", "-xzf", join(root, "payload.tgz"), "-C", out]);
      await tar.exited;
      for (const name of await readdir(out)) {
        files[name] = {
          value: await readFile(join(out, name), "utf8"),
          mode: (await stat(join(out, name))).mode & 0o777,
        };
      }
      sshArgs = await readFile(join(root, "ssh-args"), "utf8");
    }
    await chmod(root, 0o700);
    return { code, stderr, shipped, files, sshArgs };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ship-secrets.sh", () => {
  const base = ["--environment", "staging", "--secrets-dir", "/srv/secrets"];

  test("ships required, renamed and optional values as files in the directory", async () => {
    const required = "AUTHING_APP_ID OTEL_ENDPOINT=otel_traces_endpoint";
    const result = await ship([...base, "--required", required, "--optional", "SLUG"], {
      AUTHING_APP_ID: "app-id-value",
      OTEL_ENDPOINT: "https://otel.example.test",
      SLUG: "",
    });
    expect(result.code, result.stderr).toBe(0);
    expect(Object.keys(result.files).sort()).toEqual([
      "authing_app_id",
      "otel_traces_endpoint",
      "slug",
    ]);
    expect(result.files.authing_app_id).toEqual({ value: "app-id-value", mode: 0o600 });
    expect(result.files.otel_traces_endpoint?.value).toBe("https://otel.example.test");
    expect(result.files.slug?.value).toBe("");
    expect(result.sshArgs).toContain("deploy@host.example.test");
    expect(result.sshArgs).toContain("secrets_dir='/srv/secrets'");
    expect(result.sshArgs).toContain("for name in authing_app_id otel_traces_endpoint slug;");
    expect(result.sshArgs).not.toContain("app-id-value");
  });

  test("a missing required value fails by name before anything is shipped", async () => {
    const result = await ship([...base, "--required", "AUTHING_APP_ID SESSION"], {
      AUTHING_APP_ID: "app-id-value",
      SESSION: "",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("SESSION is missing from the staging GitHub Environment\n");
    expect(result.shipped).toBe(false);
  });
});
