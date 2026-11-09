import { useEffect, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import {
  departureImpactLines,
  type DepartingComputer,
  type DepartureCopy,
  type DepartureSubject,
} from "./departure-impact";

export type DepartureImpactState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; computers: DepartingComputer[] };

/**
 * Asks `load` for the Computers a departure disconnects each time the dialog opens, and again
 * when `retry` is called. `subject` names whose departure it is, so another person's answer is
 * never shown for this one. The answer is `loading` until the latest ask resolves.
 */
export function useDepartureImpact(options: {
  open: boolean;
  subject: string;
  load: () => Promise<{ computers: DepartingComputer[] }>;
}) {
  const { open, subject, load } = options;
  const [openings, setOpenings] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  const [retries, setRetries] = useState(0);
  const [answer, setAnswer] = useState<{
    ask: string;
    state: DepartureImpactState;
  }>();
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenings((count) => count + 1);
  }
  const ask = `${openings}:${subject}:${retries}`;

  useEffect(() => {
    if (!open) return;
    let stale = false;
    load().then(
      ({ computers }) => {
        if (!stale) setAnswer({ ask, state: { kind: "ready", computers } });
      },
      () => {
        if (!stale) setAnswer({ ask, state: { kind: "failed" } });
      },
    );
    return () => {
      stale = true;
    };
  }, [open, ask, load]);

  const state: DepartureImpactState = answer?.ask === ask ? answer.state : { kind: "loading" };
  return { state, retry: () => setRetries((count) => count + 1) };
}

function departureCopy(): DepartureCopy {
  const locale = getLocale();
  return {
    removeComputers: m.departure_remove_computers,
    leaveComputers: m.departure_leave_computers,
    agentsOffline: m.departure_agents_offline,
    agentsOfflineNamed: m.departure_agents_offline_named,
    computersMore: m.departure_computers_more,
    agentsMore: m.departure_agents_more,
    separator: m.departure_list_separator(),
    list: (names) =>
      locale.startsWith("zh")
        ? names.join(m.departure_list_separator())
        : new Intl.ListFormat(locale, { type: "conjunction" }).format(names),
  };
}

/**
 * What a confirmation says about the Computers a departure disconnects, below its description.
 * Nothing is shown when none disconnect; a failed check says so and offers a retry, while the
 * confirm button stays the caller's to enable.
 */
export function DepartureImpact({
  state,
  subject,
  onRetry,
}: {
  state: DepartureImpactState;
  subject: DepartureSubject;
  onRetry: () => void;
}) {
  if (state.kind === "loading")
    return (
      <p className="mt-2" data-testid="departure-impact-loading">
        {m.departure_loading()}
      </p>
    );
  if (state.kind === "failed")
    return (
      <p className="mt-2" data-testid="departure-impact-failed">
        {m.departure_failed()}{" "}
        <Button type="button" color="link-color" size="sm" onPress={onRetry}>
          {m.controls_retry()}
        </Button>
      </p>
    );
  const lines = departureImpactLines(state.computers, subject, departureCopy());
  if (!lines) return null;
  return (
    <p className="mt-2" data-testid="departure-impact">
      {lines.computers}
      {lines.agents && m.departure_sentence_joiner() + lines.agents}
    </p>
  );
}
