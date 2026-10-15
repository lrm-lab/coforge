import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_ACCOUNT_KEY_LOCK_WAIT_MS } from "../src/ov";

test(
  "parallel evaluators preserve all account keys in the shared credential file",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-account-keys-"));
    const path = join(dir, "keys.json");
    const modulePath = new URL("../src/ov.ts", import.meta.url).pathname;
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      for (const arm of ["warm", "cold"])
        children.push(
          Bun.spawn(
            [
              process.execPath,
              "-e",
              `import {rememberEvalAccountKey} from ${JSON.stringify(modulePath)}; await Bun.write(${JSON.stringify(dir)}+'/'+${JSON.stringify(arm)},'ready'); while(!await Bun.file(${JSON.stringify(dir)}+'/warm').exists()||!await Bun.file(${JSON.stringify(dir)}+'/cold').exists())await Bun.sleep(1); for(let i=0;i<30;i++)await rememberEvalAccountKey(${JSON.stringify(arm)}+i,'fixture-key');`,
            ],
            {
              env: { ...Bun.env, COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE: path },
              stdout: "pipe",
              stderr: "pipe",
              timeout: EVAL_ACCOUNT_KEY_LOCK_WAIT_MS + 1_000,
            },
          ),
        );
      for (const child of children) expect(await child.exited).toBe(0);
      const keys = await Bun.file(path).json();
      expect(Object.keys(keys)).toHaveLength(60);
      for (const arm of ["warm", "cold"])
        for (let i = 0; i < 30; i++) expect(keys[`secret:ov-${arm}${i}`]).toBe("fixture-key");
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
      await rm(dir, { recursive: true, force: true });
    }
  },
  EVAL_ACCOUNT_KEY_LOCK_WAIT_MS * 2,
);
