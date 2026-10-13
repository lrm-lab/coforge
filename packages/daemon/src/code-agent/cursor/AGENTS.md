# Cursor adapter

These rules extend [`../AGENTS.md`](../AGENTS.md).

- Launch print turns with `--output-format stream-json --stream-partial-output`. Follow the
  [official output format](https://cursor.com/docs/cli/reference/output-format): assistant text
  is new only when `timestamp_ms` is present and `model_call_id` is absent. The tool-boundary
  flush has both fields; the final flush has neither. Both repeat already streamed text.
- Cursor has no version gate. Until a turn reports a native text delta, preserve buffered text
  from older CLIs; only enable flush filtering after observing the delta framing in that turn.
- Filter these text flushes by their native frame fields, never by comparing strings: repeated
  wording in separate model deltas is legitimate text. Preserve thinking, tool and result handling.
- This framing is captured on `2026.10.01-e373342` in `test/fixtures/cursor-turn-partial.jsonl`;
  older buffered captures also protect text when no native delta framing has been observed.
