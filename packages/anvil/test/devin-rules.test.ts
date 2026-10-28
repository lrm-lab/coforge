import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDevinRuleFile } from "#src/devin/rules";

test("the standing instructions rule is private, always-on, and removed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-rules-"));
  try {
    const rule = await createDevinRuleFile(cwd, "Stay brief.\n");
    expect(rule.path.startsWith(join(await realpath(cwd), ".devin", "rules"))).toBe(true);
    expect((await Bun.file(rule.path).stat()).mode! & 0o777).toBe(0o600);
    expect(await Bun.file(rule.path).text()).toBe(
      `---\ndescription: "CoForge runtime instructions"\ntrigger: always_on\n---\n\nStay brief.\n`,
    );
    await rule.remove();
    expect(await Bun.file(rule.path).exists()).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a stale CoForge rule is cleaned up while a fresh one and the user's rules stay", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-rules-stale-"));
  try {
    const directory = join(cwd, ".devin", "rules");
    await mkdir(directory, { recursive: true });
    const stale = join(directory, "coforge-runtime-stale.md");
    const fresh = join(directory, "coforge-runtime-fresh.md");
    const user = join(directory, "my-style.md");
    await writeFile(stale, "old\n");
    await writeFile(fresh, "fresh\n");
    await writeFile(user, "user rule\n");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);

    const rule = await createDevinRuleFile(cwd, "instructions");
    try {
      const names = (await readdir(directory)).sort();
      expect(names).toContain("my-style.md");
      expect(names).toContain("coforge-runtime-fresh.md");
      expect(names).not.toContain("coforge-runtime-stale.md");
      expect(names).toContain(rule.path.split("/").pop()!);
    } finally {
      await rule.remove();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an open session's rule survives another session's sweep however old it is", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-rules-live-"));
  try {
    const first = await createDevinRuleFile(cwd, "first");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(first.path, old, old);
    const second = await createDevinRuleFile(cwd, "second");
    try {
      expect(await Bun.file(first.path).exists()).toBe(true);
    } finally {
      await second.remove();
      await first.remove();
    }
    expect(await Bun.file(first.path).exists()).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a symlinked rules directory is refused", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-rules-link-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "anvil-devin-rules-target-"));
  try {
    await mkdir(join(cwd, ".devin"), { recursive: true });
    await symlink(elsewhere, join(cwd, ".devin", "rules"));
    await expect(createDevinRuleFile(cwd, "instructions")).rejects.toThrow(/symlink/);
    expect(await readdir(elsewhere)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
