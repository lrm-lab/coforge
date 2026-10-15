import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  agentApiRoutes,
  decodeMemoryDispositionRequest,
  MEMORY_DISPOSITION_TOOL,
} from "@lrm/coforge-sdk/agent";

/** Standing task tool. Caller identity and time are provided by the server. */
export function createMemoryDispositionTool(proxy: {
  post(path: string, body: unknown): Promise<unknown>;
}) {
  return defineTool({
    name: MEMORY_DISPOSITION_TOOL,
    label: "Decide whether to use a Memory Hint",
    description:
      "For a Memory Hint addressed to you, record adopt, reject, or defer with a reason before applying it. Only this call is the receipt. It does not send a channel message or block your other tools. Adopt records intent, not proof of execution. Defer can be replaced once within the delivery TTL; adopt and reject are terminal.",
    parameters: Type.Object(
      {
        hint_id: Type.String(),
        decision: Type.Union([
          Type.Literal("adopt"),
          Type.Literal("reject"),
          Type.Literal("defer"),
        ]),
        reason: Type.String(),
        intended_action_refs: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const request = decodeMemoryDispositionRequest(params);
      const result = await proxy.post(agentApiRoutes.proxy.memoryDisposition.path, request);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  });
}
