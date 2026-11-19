import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "@inlang/paraglide-js";

import { paraglideOptions } from "../paraglide.config";

const STAMP_PATH = "node_modules/.cache/coforge-i18n.sha256";
const REQUIRED_OUTPUTS = [
  "src/paraglide/messages.js",
  "src/paraglide/messages.d.ts",
  "src/paraglide/messages/_index.js",
  "src/paraglide/runtime.js",
  "src/paraglide/runtime.d.ts",
];

async function computeInputHash(): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const files = ["package.json", "paraglide.config.ts", "project.inlang/settings.json"];
  const locales = (await readdir("messages", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const locale of locales) {
    const dir = join("messages", locale);
    const entries = (await readdir(dir)).sort();
    for (const entry of entries) {
      if (entry.endsWith(".json")) files.push(join(dir, entry));
    }
  }
  for (const file of files) {
    hasher.update(file);
    hasher.update("\0");
    hasher.update(await Bun.file(file).bytes());
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

const currentHash = await computeInputHash();
const stampFile = Bun.file(STAMP_PATH);
if (
  REQUIRED_OUTPUTS.every((path) => existsSync(path)) &&
  (await stampFile.exists()) &&
  (await stampFile.text()).trim() === currentHash
) {
  process.exit(0);
}

await compile({
  ...paraglideOptions,
  outputStructure: "message-modules",
  messageModuleSize: 512,
});

await mkdir("node_modules/.cache", { recursive: true });
await Bun.write(STAMP_PATH, `${currentHash}\n`);
