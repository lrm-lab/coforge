import { expect, test } from "bun:test";

import {
  AGENT_MESSAGE_BODY_REQUIRED_MESSAGE,
  agentMessageBody,
} from "#src/daemon-runtime/agent-message-body";

test("message is an alias of content only when content is absent", () => {
  expect(agentMessageBody(undefined, "from-message")).toBe("from-message");
  expect(agentMessageBody("from-content", "from-message")).toBe("from-content");
  expect(agentMessageBody("", "from-message")).toBe("");
  expect(agentMessageBody(undefined, undefined)).toBeUndefined();
  expect(AGENT_MESSAGE_BODY_REQUIRED_MESSAGE).toBe(
    "body required: pass content (message is accepted as alias)",
  );
});
