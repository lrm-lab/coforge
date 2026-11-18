import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readComputerUpgradeReceipt } from "#src/platform/computer-upgrade-receipts";
import { resolveComputerInstallDirectory } from "#src/platform/computer-install-directory";
import { upgradeReceiptPath } from "#src/platform/upgrade-receipt-file";

const REQUEST_ID = "00000000-0000-4000-8000-0000000000a1";
const DEAD = { pid: 4242, startedAt: "1700000000.000001", executable: "/opt/coforge/computer" };

function installerReceipt(extra: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    request_id: REQUEST_ID,
    operation: "upgrade",
    protocol: "coforge-installer/v1",
    installer_version: "1.0.0",
    status: "succeeded",
    exit_code: 0,
    version: "1.2.3",
    ...extra,
  };
}

async function read(receipt: unknown) {
  const home = await mkdtemp(join(realpathSync(tmpdir()), "coforge-upgrade-dead-"));
  try {
    const installRoot = resolveComputerInstallDirectory({
      platform: process.platform,
      homeDirectory: home,
    });
    await Bun.write(upgradeReceiptPath(installRoot, REQUEST_ID), JSON.stringify(receipt));
    return await readComputerUpgradeReceipt(REQUEST_ID, { installRoot });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a succeeded receipt carries how many stopped processes the installer proved dead", async () => {
  const receipt = await read(
    installerReceipt({ deadProcessIdentities: [DEAD, { ...DEAD, pid: 4243 }] }),
  );
  expect(receipt).toMatchObject({ status: "succeeded", version: "1.2.3", deadProcessCount: 2 });
});

test("a succeeded receipt with no dead-process identities carries no count", async () => {
  const receipt = await read(installerReceipt());
  expect(receipt).toMatchObject({ status: "succeeded", version: "1.2.3" });
  expect(receipt).not.toHaveProperty("deadProcessCount");
});
