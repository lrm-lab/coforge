import { memo, useMemo, type Key } from "react";
import { ListBox, ListBoxItem } from "react-aria-components";
import { SearchLg } from "@untitledui/icons";
import {
  HANDOFF_RUNTIME_PROVIDERS,
  type HandoffRuntimeProvider,
  type LocalSessionEntry,
} from "@lrm/coforge-sdk/internal";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { Input } from "#src/components/base/input/input";
import { RelativeTime } from "#src/components/ui/relative-time";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { HandoffProgress, HandoffRefusal } from "./handoff-states";
import {
  defaultProvider,
  isRecentlyActive,
  sessionKey,
  sessionSummary,
  sessionsByProvider,
} from "./local-session-list";
import type { SessionListState } from "./local-session-state";

export type HandoffPickerState = { query: string; tool?: HandoffRuntimeProvider };

const NO_SESSIONS: LocalSessionEntry[] = [];

/**
 * The handoff dialog's first step: the sessions on one Computer, a tab per tool, searchable by id,
 * folder or content. The search and its state are the dialog's, so choosing another session comes
 * back to the same list.
 */
export function HandoffSessionPicker({
  state,
  searching,
  onRetry,
  picker,
  onPickerChange,
  onSelect,
}: {
  state: SessionListState;
  searching: boolean;
  onRetry: () => void;
  picker: HandoffPickerState;
  onPickerChange: (picker: HandoffPickerState) => void;
  onSelect: (session: LocalSessionEntry) => void;
}) {
  const sessions = state.kind === "ready" ? state.sessions : NO_SESSIONS;
  const byTool = useMemo(() => sessionsByProvider(sessions), [sessions]);
  const tool = picker.tool ?? defaultProvider(sessions);
  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        size="sm"
        icon={SearchLg}
        aria-label={m.handoff_search_placeholder()}
        placeholder={m.handoff_search_placeholder()}
        value={picker.query}
        onChange={(query) => onPickerChange({ ...picker, query })}
      />
      <Tabs
        selectedKey={tool}
        onSelectionChange={(key: Key) => {
          const next = HANDOFF_RUNTIME_PROVIDERS.find((provider) => provider === key);
          if (next) onPickerChange({ ...picker, tool: next });
        }}
      >
        <TabList aria-label={m.handoff_source()} type="underline" className="gap-4">
          {HANDOFF_RUNTIME_PROVIDERS.map((provider) => {
            const count = byTool[provider].length;
            return (
              <Tab key={provider} id={provider} badge={count > 0 ? count : undefined}>
                {runtimeProviderLabel(provider)}
              </Tab>
            );
          })}
        </TabList>
        <TabPanel id={tool} className="pt-3">
          <SessionListBody
            state={state}
            listed={byTool[tool]}
            tool={tool}
            query={picker.query}
            searching={searching}
            onSelect={onSelect}
            onRetry={onRetry}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function SessionListBody({
  state,
  listed,
  tool,
  query,
  searching,
  onSelect,
  onRetry,
}: {
  state: SessionListState;
  listed: LocalSessionEntry[];
  tool: HandoffRuntimeProvider;
  query: string;
  searching: boolean;
  onSelect: (session: LocalSessionEntry) => void;
  onRetry: () => void;
}) {
  if (state.kind === "loading") return <HandoffProgress label={m.handoff_loading()} />;
  if (state.kind !== "ready") {
    if (state.kind === "unsupported")
      return <HandoffRefusal color="warning" text={m.handoff_unsupported()} />;
    return state.kind === "offline" ? (
      <HandoffRefusal color="warning" text={m.handoff_offline()} onRetry={onRetry} />
    ) : (
      <HandoffRefusal color="gray" text={m.handoff_busy()} onRetry={onRetry} />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {searching && <HandoffProgress label={m.handoff_searching()} />}
      {listed.length === 0 ? (
        <p className="py-8 text-center text-sm text-tertiary">
          {state.sessions.length === 0
            ? m.handoff_empty()
            : query.trim()
              ? m.handoff_no_match()
              : m.handoff_tool_empty({ tool: runtimeProviderLabel(tool) })}
        </p>
      ) : (
        <SessionList sessions={listed} onSelect={onSelect} />
      )}
      {state.incomplete && <p className="text-sm text-tertiary">{m.handoff_incomplete()}</p>}
    </div>
  );
}

function SessionList({
  sessions,
  onSelect,
}: {
  sessions: LocalSessionEntry[];
  onSelect: (session: LocalSessionEntry) => void;
}) {
  const now = Date.now();
  return (
    <ListBox
      aria-label={m.handoff_session_list()}
      selectionMode="none"
      onAction={(key) => {
        const session = sessions.find((candidate) => sessionKey(candidate) === key);
        if (session) onSelect(session);
      }}
      className="max-h-80 divide-y divide-secondary overflow-y-auto rounded-xl border border-secondary"
    >
      {sessions.map((session) => (
        <SessionRow
          key={sessionKey(session)}
          session={session}
          active={isRecentlyActive(session.updatedAtMs, now)}
        />
      ))}
    </ListBox>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  active,
}: {
  session: LocalSessionEntry;
  active: boolean;
}) {
  const summary = sessionSummary(session);
  const title = summary.title || m.handoff_untitled();
  return (
    <ListBoxItem
      id={sessionKey(session)}
      textValue={title}
      className={({ isHovered, isFocusVisible }) =>
        cx(
          "flex cursor-pointer items-start gap-3 px-3 py-2.5 outline-hidden",
          isHovered && "bg-primary_hover",
          isFocusVisible && "bg-primary_hover outline-2 -outline-offset-2 outline-focus-ring",
        )
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-primary">{title}</span>
          {active && (
            <Badge size="sm" color="warning" className="shrink-0">
              {m.handoff_active_badge()}
            </Badge>
          )}
        </div>
        <div className="truncate text-xs text-tertiary">{summary.place}</div>
        {session.matchKind === "content" && session.snippet && (
          <div className="truncate text-xs text-tertiary">{session.snippet}</div>
        )}
      </div>
      <RelativeTime
        plain
        value={new Date(session.updatedAtMs)}
        className="shrink-0 pt-0.5 text-xs text-tertiary"
      />
    </ListBoxItem>
  );
});
