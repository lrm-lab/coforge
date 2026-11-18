import { resolve } from "node:path";

export const evidenceDirectory = resolve(import.meta.dir, "../../.amp/in/artifacts");
export const failureSnapshotPath = resolve(import.meta.dir, "../../.amp/e2e/native-browser-failure.txt");

export async function controlComputer(action: "stop" | "start") {
  const executable = Bun.which("coforge-computer");
  if (!executable) throw new Error("Installed Computer is required");
  const child = Bun.spawn([executable, action], { stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Computer ${action} failed: ${stderr}`);
}

export function nativeBrowser(browserPath: string, session: string) {
  async function browser(...args: string[]) {
    const child = Bun.spawn(
      [browserPath, "--session", session, "--ignore-https-errors", ...args],
      {
        env: { ...Bun.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "15000" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Native browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  async function click(role: string, label: string) {
    await browser("find", "role", role, "click", "--name", label, "--exact");
    if (role === "option")
      await browser("wait", "--fn", "!document.querySelector('[role=listbox]')");
  }
  return { browser, click };
}
