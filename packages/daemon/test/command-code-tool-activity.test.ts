import { expect, test } from "bun:test";
import { toolActivity } from "#src/code-agent/tool-activity";

test("Command Code shell tool names keep command semantics", () => {
  for (const name of ["shell_command", "powershell"])
    expect(toolActivity(name, { command: "pwd" })).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "pwd" }],
    });
});
