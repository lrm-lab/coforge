import {
  InstallerReceiptSchema,
  UPGRADE_RECEIPT_MAX_BYTES,
} from "@lrm/coforge-sdk/internal/upgrade-receipt";
import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal/uuid";
import { resolveComputerInstallDirectory } from "./computer-install-directory";
import { installerJournalPath } from "./installer-journal";
import { readUpgradeReceipt } from "./upgrade-receipt-file";

function journalRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { schema_version, request_id, from, from_previous, to, supervisor_running } =
    value as Record<string, unknown>;
  if (
    schema_version !== 1 ||
    typeof request_id !== "string" ||
    !RFC_UUID_PATTERN.test(request_id) ||
    typeof to !== "string" ||
    typeof supervisor_running !== "boolean"
  )
    return undefined;
  if (
    (from != null && typeof from !== "string") ||
    (from_previous != null && typeof from_previous !== "string")
  )
    return undefined;
  return request_id;
}

export async function installerRecoveryRequired(
  installRoot = resolveComputerInstallDirectory(),
  readReceipt = readUpgradeReceipt,
): Promise<boolean> {
  const path = installerJournalPath(installRoot);
  try {
    const journal = await readJournal(path);
    const requestId = journalRequestId(JSON.parse(journal));
    if (!requestId) return false;
    const receipt = await readReceipt(installRoot, requestId);
    const native = InstallerReceiptSchema.safeParse(receipt?.result);
    if (
      !native.success ||
      native.data.operation !== "upgrade" ||
      native.data.outcome !== "unresolved"
    )
      return false;
    return (await readJournal(path)) === journal;
  } catch {
    return false;
  }
}

async function readJournal(path: string): Promise<string> {
  const bytes = await Bun.file(path)
    .slice(0, UPGRADE_RECEIPT_MAX_BYTES + 1)
    .arrayBuffer();
  if (bytes.byteLength > UPGRADE_RECEIPT_MAX_BYTES)
    throw new Error("installer journal exceeds the read limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
