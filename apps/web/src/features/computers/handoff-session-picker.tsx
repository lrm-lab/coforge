import type { Key } from "react";
import { ListBox, ListBoxItem } from "react-aria-components";
import { SearchLg } from "@untitledui/icons";
import type { HandoffRuntimeProvider, LocalSessionEntry } from "@lrm/coforge-sdk/internal";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Alert } from "#src/components/ui/alert";
import { RelativeTime } from "#src/components/ui/relative-time";
import { Spinner } from "#src/components/ui/spinner";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  defaultProvider,
  HANDOFF_PROVIDERS,
  isRecentlyActive,
  sessionKey,
  sessionsByProvider,
  shortenPath,
  sortSessions,
} from "./handoff-briefing";
import type { SessionListState } from "./local-session-state";
import { useLocalSessionSearch } from "./use-local-session-handoff";

export type HandoffPickerState = { query: string; tool?: HandoffRuntimeProvider };

/**
 * The handoff dialog's first step: the sessions on one Computer, a tab per tool, searchable by id,
 * folder or content. The search state is the dialog's, so choosing another session comes back to
 * the same list.
 */
export function HandoffSessionPicker({
  computerId,
  picker,
  onPickerChange,
  onSelect,
}: {
  computerId: string;
  picker: HandoffPickerState;
  onPickerChange: (picker: HandoffPickerState) => void;
  onSelect: (session: LocalSessionEntry) => void;
}) {
  const { state, searching, retry } = useLocalSessionSearch(computerId, picker.query);
  const sessions = state.kind === "ready" ? sortSessions(state.sessions) : [];
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
          const next = HANDOFF_PROVIDERS.find((provider) => provider === key);
          if (next) onPickerChange({ ...picker, tool: next });
        }}
      >
        <TabList aria-label={m.handoff_source()} type="underline" className="gap-4">
          {HANDOFF_PROVIDERS.map((provider) => {
            const count = sessionsByProvider(sessions, provider).length;
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
            sessions={sessions}
            tool={tool}
            searching={searching}
            onSelect={onSelect}
            onRetry={retry}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function SessionListBody({
  state,
  sessions,
  tool,
  searching,
  onSelect,
  onRetry,
}: {
  state: SessionListState;
  sessions: LocalSessionEntry[];
  tool: HandoffRuntimeProvider;
  searching: boolean;
  onSelect: (session: LocalSessionEntry) => void;
  onRetry: () => void;
}) {
  if (state.kind === "loading") return <Progress label={m.handoff_loading()} />;
  if (state.kind !== "ready") {
    if (state.kind === "unsupported")
      return <Refusal color="warning" text={m.handoff_unsupported()} />;
    return state.kind === "offline" ? (
      <Refusal color="warning" text={m.handoff_offline()} onRetry={onRetry} />
    ) : (
      <Refusal color="gray" text={m.handoff_busy()} onRetry={onRetry} />
    );
  }

  const listed = sessionsByProvider(sessions, tool);
  return (
    <div className="flex flex-col gap-2">
      {searching && <Progress label={m.handoff_searching()} />}
      {listed.length === 0 ? (
        <p className="py-8 text-center text-sm text-tertiary">
          {sessions.length === 0
            ? m.handoff_empty()
            : m.handoff_tool_empty({ tool: runtimeProviderLabel(tool) })}
        </p>
      ) : (
        <SessionList sessions={listed} onSelect={onSelect} />
      )}
      {state.incomplete && <p className="text-sm text-tertiary">{m.handoff_incomplete()}</p>}
    </div>
  );
}

function Progress({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-6 text-sm text-tertiary"
    >
      <Spinner className="size-4" />
      {label}
    </div>
  );
}

function Refusal({
  color,
  text,
  onRetry,
}: {
  color: "gray" | "warning";
  text: string;
  onRetry?: () => void;
}) {
  return (
    <Alert
      color={color}
      description={text}
      actions={
        onRetry && (
          <Button color="secondary" size="sm" onPress={onRetry}>
            {m.handoff_retry()}
          </Button>
        )
      }
    />
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
      aria-label={m.handoff_title()}
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

function SessionRow({ session, active }: { session: LocalSessionEntry; active: boolean }) {
  const title = session.title.trim() || m.handoff_untitled();
  const place = [shortenPath(session.cwd), session.model].filter(Boolean).join(" · ");
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
        <div className="truncate text-xs text-tertiary">{place}</div>
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
}
