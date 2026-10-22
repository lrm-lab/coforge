import { describe, expect, test } from "bun:test";
import { OPENVIKING_AGENT_PROTOCOL, OPENVIKING_TOOL_NAMES } from "@lrm/coforge-sdk/agent";
import { channelTraceFromSteps } from "#src/channel-turn-trace";
import type { AgentTrainingStep } from "#src/training-trajectory";

const tool = (
  id: string,
  toolName: string,
  input: unknown,
  output: string,
  isError = false,
): AgentTrainingStep => ({ kind: "tool", toolCallId: id, toolName, input, output, isError });

describe("channelTraceFromSteps", () => {
  test("splits tool calls at each send and records what check showed", () => {
    const sent1 = "0197aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    const sent2 = "0197aaaa-cccc-7ccc-8ddd-eeeeeeeeeeee";
    const trace = channelTraceFromSteps("s1", [
      { kind: "user", text: "[CoForge inbox notice: ...]" },
      tool(
        "c1",
        "bash",
        { command: "coforge message check" },
        "[target=#t msg=0197aaaa-bbb time=x type=human] u: hi\n\nNo more new messages.",
      ),
      tool("c2", "ov_fork_find", { query: "q" }, "result"),
      tool(
        "c3",
        "bash",
        { command: "coforge message send --target '#t' --text hi" },
        `Message sent to #t. Message ID: ${sent1}`,
      ),
      tool("c4", "bash", { command: "ls" }, "a.txt"),
      tool(
        "c5",
        OPENVIKING_TOOL_NAMES.offer,
        {},
        JSON.stringify({
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op: "offer",
          published: true,
          messageId: sent2,
        }),
      ),
      tool(
        "c6",
        "bash",
        { command: "coforge message read --target '#t'" },
        "[target=#t msg=0197aaaa-ccc time=x type=agent] a: x",
      ),
    ]);
    expect(trace.sends.map((send) => send.messageId)).toEqual([sent1, sent2]);
    expect(trace.sends[0]!.toolExchanges.map((e) => e.toolCallId)).toEqual(["c1", "c2"]);
    expect(trace.sends[0]!.receivedShortIds).toEqual(["0197aaaa-bbb"]);
    expect(trace.sends[1]!.toolExchanges.map((e) => e.toolCallId)).toEqual(["c4"]);
    expect(trace.trailingReceivedShortIds).toEqual(["0197aaaa-ccc"]);
  });

  test("native memory-agent message tools count as reads and sends", () => {
    const sent = "0197aaaa-dddd-7ccc-8ddd-eeeeeeeeeeee";
    const trace = channelTraceFromSteps("s3", [
      tool(
        "c1",
        "message_read",
        { target: "#t" },
        "[target=#t msg=0197aaaa-bbb time=x type=human] u: hi",
      ),
      tool(
        "c2",
        "send_channel_message",
        { target: "#t", content: "ok" },
        `Message sent to #t. Message ID: ${sent}`,
      ),
    ]);
    expect(trace.sends).toHaveLength(1);
    expect(trace.sends[0]!.receivedShortIds).toEqual(["0197aaaa-bbb"]);
    expect(trace.sends[0]!.toolExchanges.map((e) => e.toolName)).toEqual(["message_read"]);
  });

  test("a failed send is an ordinary tool call, not a message boundary", () => {
    const trace = channelTraceFromSteps("s2", [
      tool("c1", "bash", { command: "coforge message send --text x" }, "boom", true),
    ]);
    expect(trace.sends).toEqual([]);
    expect(trace.trailingReceivedShortIds).toEqual([]);
  });
});
