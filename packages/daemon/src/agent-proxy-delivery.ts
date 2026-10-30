import { takeClaims } from "#src/daemon-runtime/response-claims";

/**
 * `response`, with what it used up in the Agent's context ledger given back when it never reaches
 * the Agent: the client left before the response was built, or stopped reading it. The claims are
 * made when the response is built, so only this write can tell they were wasted. A response that
 * carries none comes back as it is.
 */
export function guardDelivery(response: Response, result: unknown, signal: AbortSignal): Response {
  const release = takeClaims((result as { messages?: unknown } | undefined)?.messages);
  if (!release) return response;
  let finished = false;
  const giveBack = () => {
    if (finished) return;
    finished = true;
    release();
  };
  if (signal.aborted || !response.body) {
    if (signal.aborted) giveBack();
    return response;
  }
  signal.addEventListener("abort", giveBack, { once: true });
  const reader = response.body.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (!done) return controller.enqueue(value);
      finished = true;
      signal.removeEventListener("abort", giveBack);
      controller.close();
    },
    cancel(reason) {
      giveBack();
      return reader.cancel(reason);
    },
  });
  return new Response(guarded, response);
}
