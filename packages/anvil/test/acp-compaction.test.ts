import { expect, test } from "bun:test";
import { AntigravityAcpTurnEvents } from "@lrm/coforge-anvil/antigravity";
import { CommandCodeTurnEvents } from "@lrm/coforge-anvil/command-code";
import { CursorAcpTurnEvents } from "@lrm/coforge-anvil/cursor";
import { DevinTurnEvents } from "@lrm/coforge-anvil/devin";
import { DshTurnEvents } from "@lrm/coforge-anvil/dsh";
import { OpenCodeAcpTurnEvents } from "@lrm/coforge-anvil/opencode";

/** Every translator only needs a scanner from its host; compaction never touches it. */
const host = {
  createReplyIntentScanner: () => ({
    feed: () => undefined,
    complete: () => {},
    reset: () => [],
  }),
};

test("every ACP translator reports the compaction transitions its agent sends", () => {
  const translators = [
    new DevinTurnEvents(host as never),
    new CursorAcpTurnEvents(host as never),
    new DshTurnEvents(host as never),
    new CommandCodeTurnEvents(host as never),
    new OpenCodeAcpTurnEvents(host as never),
    new AntigravityAcpTurnEvents(host as never),
  ];
  for (const translator of translators) {
    const update = (status: string) => ({ sessionUpdate: "compaction_update", status });
    expect(translator.read(update("in_progress"))).toEqual([{ type: "compaction-started" }]);
    expect(translator.read(update("completed"))).toEqual([{ type: "compaction-finished" }]);
    expect(translator.read(update("failed"))).toEqual([{ type: "compaction-interrupted" }]);
    expect(translator.read(update("cancelled"))).toEqual([{ type: "compaction-interrupted" }]);
    expect(translator.read(update("future_status"))).toEqual([]);
  }
});
