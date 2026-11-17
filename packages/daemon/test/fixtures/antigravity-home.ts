import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs `body` with `HOME` set to a fresh directory holding the given `.gemini` files, so the
 * production Antigravity host reads a known sign-in instead of the machine's own (a developer's
 * Mac has one, CI does not).
 */
export async function withAntigravityHome<T>(
  files: Readonly<Record<string, string>>,
  body: () => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "coforge-antigravity-home-"));
  const before = { HOME: Bun.env.HOME, USERPROFILE: Bun.env.USERPROFILE };
  try {
    await mkdir(join(home, ".gemini"));
    for (const [name, content] of Object.entries(files))
      await writeFile(join(home, ".gemini", name), content);
    Bun.env.HOME = home;
    delete Bun.env.USERPROFILE;
    return await body();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

/** A cached Antigravity sign-in: the account id `agy` writes after a login. */
export const SIGNED_IN = { google_account_id: "fixture-account\n" } as const;
