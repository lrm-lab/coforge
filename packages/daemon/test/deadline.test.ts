import { expect, test } from "bun:test";
import { withDeadline } from "#src/code-agent/deadline";

test("a deadline whose timeout handler throws rejects with that error", async () => {
  const handlerFailure = new Error("kill failed");
  const pending = withDeadline(new Promise<never>(() => {}), 1, () => {
    throw handlerFailure;
  });
  await expect(pending).rejects.toBe(handlerFailure);
});
