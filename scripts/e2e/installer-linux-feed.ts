// Writes a local release feed for the Linux installer E2E (scripts/e2e/installer-linux.sh): the
// Computer tree of one version (`<version>/...`, `latest`) and the installer tree
// (`installer/latest`, `installer/<iv>/manifest.json`, `installer/<iv>/linux-arm64/...`), built
// with the same functions the release workflow uses. Local output only: nothing is uploaded.
//
// usage: bun scripts/e2e/installer-linux-feed.ts <feedDirectory> <computerPackageDirectory> \
//          <installerVersion> <installerBinary> <commit>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildReleaseTree } from "../release/build-release";
import {
  assembleInstallerManifest,
  readInstallerTargetPlatform,
  writeInstallerTargetObjects,
} from "../release/build-installer-release";

const TARGET = "linux-arm64";
const INSTALLER_PROTOCOL = 1; // packages/computer/src/release/installer-contract.ts INSTALLER_PROTOCOL

const [feedDirectory, packageDirectory, installerVersion, installerBinary, commit] =
  Bun.argv.slice(2);
if (!feedDirectory || !packageDirectory || !installerVersion || !installerBinary || !commit) {
  throw new Error(
    "usage: installer-linux-feed.ts <feedDirectory> <computerPackageDirectory> <installerVersion> <installerBinary> <commit>",
  );
}

const manifest = JSON.parse(await readFile(join(packageDirectory, "manifest.json"), "utf8"));
const computer = Bun.gunzipSync(
  new Uint8Array(await readFile(join(packageDirectory, "coforge-computer.gz"))),
);
const photonWasm = new Uint8Array(await readFile(join(packageDirectory, "photon_rs_bg.wasm")));
const buildDate = new Date().toISOString();

const tree = await buildReleaseTree(
  {
    version: manifest.version,
    commit,
    buildDate,
    artifacts: { [TARGET]: { computer: new Uint8Array(computer), cli: new TextEncoder().encode("unused standalone cli") } },
    photonWasm,
  },
  feedDirectory,
);
await writeFile(join(feedDirectory, "latest"), `${manifest.version}\n`);

const installerBytes = new Uint8Array(await readFile(installerBinary));
await writeInstallerTargetObjects(
  { version: installerVersion, target: TARGET, binary: installerBytes },
  feedDirectory,
);
const platform = await readInstallerTargetPlatform(installerVersion, TARGET, feedDirectory);
const installerManifest = assembleInstallerManifest({
  version: installerVersion,
  commit,
  buildDate,
  installerProtocol: INSTALLER_PROTOCOL,
  platforms: { [TARGET]: platform },
});
await mkdir(join(feedDirectory, "installer", installerVersion), { recursive: true });
await writeFile(
  join(feedDirectory, "installer", installerVersion, "manifest.json"),
  `${JSON.stringify(installerManifest, null, 2)}\n`,
);
await writeFile(join(feedDirectory, "installer", "latest"), `${installerVersion}\n`);

console.log(
  JSON.stringify({
    computerVersion: manifest.version,
    computerFiles: tree.files,
    installerVersion,
  }),
);
