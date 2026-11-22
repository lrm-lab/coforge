import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginLocalUpgradeProgress,
  readLocalUpgradeContext,
} from "../src/platform/computer-upgrade-progress";

const scratch: string[] = [];
export async function cleanupFixtures() {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cf-upgrade-"));
  scratch.push(root);
  const installRoot = join(root, "install");
  const stateDirectory = join(root, "daemon");
  await mkdir(installRoot);
  const requestId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const version = "2.0.0";
  await beginLocalUpgradeProgress(installRoot, workspaceId, requestId, version);
  const local = await readLocalUpgradeContext(installRoot, requestId);
  if (!local) throw new Error("progress context missing");
  return { installRoot, stateDirectory, requestId, workspaceId, version, ...local };
}
