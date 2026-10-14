import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("boot themeScript does not activate dark-mode by default on unconfigured devices", () => {
  const rootSource = readFileSync(new URL("../src/routes/__root.tsx", import.meta.url), "utf8");
  const match = rootSource.match(/const themeScript = `([\s\S]*?)`;/);
  expect(match).toBeTruthy();
  const script = match![1]!;

  // Must not have (!theme||theme==="system")
  expect(script).not.toContain("!theme||");
  expect(script).toContain('theme==="system"&&matchMedia("(prefers-color-scheme: dark)").matches');
  expect(script).toContain('theme==="dark"');
});

test("settings route defaults initialTheme to light when no theme preference is stored", () => {
  const settingsSource = readFileSync(
    new URL("../src/routes/w.$workspaceSlug/settings.tsx", import.meta.url),
    "utf8",
  );
  expect(settingsSource).toContain(': "light";');
  expect(settingsSource).not.toContain(': "system";');
});
