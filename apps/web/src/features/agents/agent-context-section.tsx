import { useHydrated } from "@tanstack/react-router";

import { TimeMessage, UsageWindow } from "#src/features/computers/usage-window";
import { getLocale } from "#src/paraglide/runtime";
import { m } from "#src/paraglide/messages";

function contextUsedPercent(usedTokens: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((usedTokens / windowTokens) * 100)));
}

export function AgentContextSection({
  usage,
  timeZone = null,
}: {
  usage: { usedTokens: number; windowTokens: number; observedAtMs: number };
  timeZone?: string | null;
}) {
  const hydrated = useHydrated();
  const numberFormat = new Intl.NumberFormat(getLocale());

  return (
    <div>
      <UsageWindow
        label={m.agent_context_title()}
        window={{ usedPercent: contextUsedPercent(usage.usedTokens, usage.windowTokens) }}
        timeZone={timeZone}
        resetExpected={false}
      />
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs break-words tabular-nums text-tertiary">
        <span>
          {m.agent_context_tokens_of({
            tokens: numberFormat.format(usage.usedTokens),
            window: numberFormat.format(usage.windowTokens),
          })}
        </span>
        {hydrated && (
          <span>
            <TimeMessage
              message={(time) => m.agent_context_updated({ time })}
              value={new Date(usage.observedAtMs)}
              timeZone={timeZone}
            />
          </span>
        )}
      </p>
    </div>
  );
}
