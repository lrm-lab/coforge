import { expect, test } from "bun:test";
import { CodexWorkbenchSession } from "@lrm/coforge-anvil/codex";

const threadId = crypto.randomUUID();

test("Codex workbench accepts only live approval requests for its native thread", async () => {
  const records = new Set<(record: Readonly<Record<string, unknown>>) => void>();
  const controls = Promise.withResolvers<void>();
  const decisions: unknown[] = [];
  const emit = (record: Readonly<Record<string, unknown>>) => {
    for (const listener of records) listener(record);
  };
  const session = new CodexWorkbenchSession(
    {
      onRecord: (listener) => {
        records.add(listener);
        return () => records.delete(listener);
      },
      onFailure: () => () => {},
      onClose: () => () => {},
      dispose: async () => {},
      send: async (record) => {
        decisions.push(record);
      },
      request: async () => {
        controls.resolve();
        return { result: { turn: { id: "turn" } } };
      },
    },
    threadId,
    "codex",
    [],
    () => {},
  );
  const turn = session.prompt("Inspect the branch");
  await controls.promise;
  emit({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "another-thread", turnId: "turn", command: "pwd" },
  });
  emit({
    id: 2,
    method: "item/commandExecution/requestApproval",
    params: { threadId, turnId: "turn", command: "pwd" },
  });
  expect(session.approvals()).toMatchObject([{ kind: "command", detail: "pwd" }]);
  const [approval] = session.approvals();
  await session.decide(approval!.id, "deny");
  await expect(session.decide(approval!.id, "allow")).rejects.toThrow("no longer pending");
  emit({
    method: "turn/completed",
    params: { threadId, turn: { id: "turn", status: "completed" } },
  });
  await turn;
  expect(decisions).toMatchObject([
    { id: 1, error: { code: -32601 } },
    { id: 2, result: { decision: "decline" } },
  ]);
  expect(session.approvals()).toEqual([]);
});
