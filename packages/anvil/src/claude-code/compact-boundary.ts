import { asRecord, integerField } from "#src/json-record";

export function compactBoundaryTokens(record: Readonly<Record<string, unknown>>) {
  const metadata = asRecord(record.compact_metadata);
  const pre = integerField(metadata?.pre_tokens);
  const post = integerField(metadata?.post_tokens);
  return {
    ...(pre !== undefined && pre >= 0 ? { runtimePreTokens: pre } : {}),
    ...(post !== undefined && post >= 0 ? { runtimePostTokens: post } : {}),
  };
}
