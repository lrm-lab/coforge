import { basename, dirname } from "node:path";
import { sha256 } from "./annotation";

const APPROVED: Record<string, { bodySha256: string; approvedBy: string; reason: string }> = {
  "20261118150000_task_thread_duplicate_notices_drop": {
    bodySha256: "c3c4b828447641f2f0788262adfc8c73561fed4d10f2c4d532d1bf1356e63a97",
    approvedBy: "Frank, 2026-11-18",
    reason:
      "deletes a few hundred task_thread notices by primary key through system_messages; ROW EXCLUSIVE only",
  },
};

export function approvedRewrite(file: string, body: string): boolean {
  const approval = APPROVED[basename(dirname(file))];
  return approval !== undefined && approval.bodySha256 === sha256(body);
}
