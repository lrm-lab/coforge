import { useEffect, useState } from "react";

import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { parseCodeDestination } from "./code-destination";

/** Seconds before another code can be asked for: Authing sends one per destination a minute. */
const RESEND_SECONDS = 60;

type SendProblem = "invalid_destination" | "rate_limited" | "send_failed";

/**
 * Asking for a verification code from a form: one request at a time, and none for a minute after
 * one was sent (`secondsLeft` counts the minute down). `onSend` judges the typed `destination`
 * first, then has `request` ask for the code; whatever went wrong goes to `setProblem`, and a code
 * on its way to `onSent`. A throw is `send_failed`.
 */
export function useCodeSending({
  destination,
  request,
  setProblem,
  onSent,
}: {
  destination: string;
  request: (destination: string) => Promise<{ ok: true } | { ok: false; problem: SendProblem }>;
  setProblem: (problem: SendProblem | null) => void;
  onSent?: () => void;
}) {
  const [sending, guard] = useSubmitGuard();
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft(secondsLeft - 1), 1_000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function onSend() {
    // The server judges it again; asking here first only spares a round trip.
    if (!parseCodeDestination(destination)) return setProblem("invalid_destination");
    setProblem(null);
    if (secondsLeft > 0) return;
    const result = await guard(async () => {
      try {
        const answer = await request(destination);
        if (answer.ok) setSecondsLeft(RESEND_SECONDS);
        return answer;
      } catch {
        return { ok: false, problem: "send_failed" } as const;
      }
    });
    if (!result) return;
    if (result.ok) onSent?.();
    else setProblem(result.problem);
  }

  return { sending, secondsLeft, onSend };
}
