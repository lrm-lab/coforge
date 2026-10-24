import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { StreamedJsonStringField } from "./streamed-json-string-field";
import { sendCommandTarget } from "./send-command-target";

/** Calls scanned at once; the oldest is forgotten past this. */
export const REPLY_INTENT_SCANNER_MAX_CALLS = 16;
/** A call whose arguments text passes this is given up on. */
export const REPLY_INTENT_SCANNER_MAX_ARGUMENTS_CHARS = 8 * 1024;

/** The characters after which a command's last token may be closed: a shell token boundary. */
const TOKEN_BOUNDARY = /[\s'"|;&<>()]/;
/** The command line is read as an invocation of this executable and nothing else. */
const EXECUTABLE = /coforge/i;
/** Where the shell tokenizer stops reading a command: a newline or a heredoc. */
const END_OF_COMMAND = /\n|<</;

/** One fragment of a shell tool call's JSON arguments, as a provider streams them. */
export type ToolArgumentDelta = {
  callId: string;
  fragment: string;
};

type ScannedCall = {
  /** What the call's arguments have added up to, in characters. */
  argumentChars: number;
  command: StreamedJsonStringField;
  /** The command's length when it was last checked. */
  checkedLength: number;
  /** Nothing more to learn from this call: it was announced, or cannot be a message send. */
  settled: boolean;
  announced: boolean;
};

/**
 * Finds the Agent's own message send while the model is still writing the tool call, from the
 * call's argument fragments alone. It knows no provider: an adapter feeds it each fragment of a
 * shell tool call (id, JSON text) and passes on the neutral `reply-intent` event it returns.
 *
 * Only the `command` field is read, and only once it mentions `coforge` and has gained a shell
 * token boundary (or its string completes): the command so far is then read as a message send
 * whose target token is closed. The first match is the call's one announcement. A command that
 * ends (a newline or heredoc) or completes without a match, and one whose arguments grow past a
 * cap, is given up on. A call that finishes without an announcement is not this module's
 * business: the daemon announces it from its `tool-start`. State is bounded: a few calls, a few
 * KiB each.
 */
export class ReplyIntentScanner {
  readonly #calls = new Map<string, ScannedCall>();

  feed(delta: ToolArgumentDelta): Extract<AgentRuntimeEvent, { type: "reply-intent" }> | undefined {
    const call = this.#call(delta.callId);
    if (call.settled) return undefined;
    call.argumentChars += delta.fragment.length;
    if (call.argumentChars <= REPLY_INTENT_SCANNER_MAX_ARGUMENTS_CHARS)
      call.command.push(delta.fragment);
    if (call.argumentChars > REPLY_INTENT_SCANNER_MAX_ARGUMENTS_CHARS || call.command.failed) {
      call.settled = true;
      return undefined;
    }
    const { value, complete } = call.command;
    const added = value.slice(call.checkedLength);
    call.checkedLength = value.length;
    if (!complete && !TOKEN_BOUNDARY.test(added)) return undefined;
    if (EXECUTABLE.test(value)) {
      const target = sendCommandTarget(value, complete ? "complete" : "partial");
      if (target) {
        call.settled = call.announced = true;
        return { type: "reply-intent", id: delta.callId, target };
      }
    } else if (END_OF_COMMAND.test(value)) {
      call.settled = true;
    }
    if (complete) call.settled = true;
    return undefined;
  }

  /** The call's arguments are whole: nothing about it is kept. */
  complete(callId: string): void {
    this.#calls.delete(callId);
  }

  /**
   * A turn or session boundary: every call in flight is forgotten. Returns the ones announced
   * whose arguments never completed, which the model abandoned.
   */
  reset(): string[] {
    const abandoned = [...this.#calls].filter(([, call]) => call.announced).map(([id]) => id);
    this.#calls.clear();
    return abandoned;
  }

  #call(callId: string): ScannedCall {
    const known = this.#calls.get(callId);
    if (known) return known;
    const call: ScannedCall = {
      argumentChars: 0,
      command: new StreamedJsonStringField("command"),
      checkedLength: 0,
      settled: false,
      announced: false,
    };
    this.#calls.set(callId, call);
    if (this.#calls.size > REPLY_INTENT_SCANNER_MAX_CALLS)
      this.#calls.delete(this.#calls.keys().next().value!);
    return call;
  }
}
