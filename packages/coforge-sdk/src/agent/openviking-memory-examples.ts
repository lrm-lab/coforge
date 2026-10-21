import type { OpenVikingAgentOperation } from "./openviking-memory";

/** One complete arguments object per operation. Placeholders are meant to be copied. */
export const OPENVIKING_ARGUMENT_EXAMPLES: Record<OpenVikingAgentOperation, string> = {
  diagnose: '{"operationId":"diagnose-1","messageId":"<求助消息 id>"}',
  fork_find: '{"operationId": "find-1", "query": "<检索词>", "limit": 10}',
  search_context: '{"operationId": "search-1", "query": "<检索词>", "limit": 10}',
  read: '{"operationId": "read-1", "uri": "<document uri>"}',
  expand:
    '{"operationId": "hop-1", "chainRef": "<ov_fork_find chainRef>", "uri": "<served node uri>", "relation": "anchor", "limit": 5}',
  offer:
    '{"operationId": "offer-1", "citationRefs": ["<ov_fork_find/ov_expand 返回的 citation id>"], "body": "<给 @task 的正文>"}',
};

/** Channel fence tools. Not OpenViking commands; kept beside the examples models copy. */
export const CHANNEL_ARGUMENT_EXAMPLES = {
  message_read: '{"target": "#<频道名>"}',
  send_channel_message: '{"target": "#<频道名>", "content": "<正文>"}',
} as const;

export const OPENVIKING_REQUIRED_FIELDS: Record<OpenVikingAgentOperation, readonly string[]> = {
  diagnose: ["operationId", "messageId"],
  fork_find: ["operationId", "query"],
  search_context: ["operationId", "query"],
  read: ["operationId", "uri"],
  expand: ["operationId", "chainRef", "uri", "relation"],
  offer: ["operationId", "citationRefs", "body"],
};
