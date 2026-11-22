import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { searchForwardDestinations } from "#src/features/conversations/message-forward.functions";
import { forwardTargetKey } from "#src/features/conversations/message-forward-model";
import type { ForwardTarget } from "#src/features/conversations/message-forward";
import {
  EntityPicker,
  Face,
  agentHandle,
  type PickerFace,
} from "#src/features/pickers/entity-picker";
import { useLiveChannelRow } from "#src/features/conversations/sidebar-lists";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { TaskFieldTrigger } from "./task-field-trigger";

const LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 250;

function faceOf(target: ForwardTarget): PickerFace {
  if (target.kind === "channel")
    return { kind: "channel", visibility: target.visibility, members: target.members };
  return {
    kind: "identity",
    name: target.name,
    src: target.avatarUrl,
    ...(target.kind === "person" ? { userId: target.userId } : { agentId: target.agentId }),
  };
}

export function assignTargetName(target: ForwardTarget) {
  if (target.kind === "channel") return target.name;
  if (target.kind === "person") return humanLabel({ displayName: target.name });
  return `@${target.handle}`;
}

export function useAssignTargets({ enabled = true }: { enabled?: boolean } = {}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const search = useServerFn(searchForwardDestinations);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const targets = useQuery({
    queryKey: ["task-assign-targets", workspaceId, term],
    queryFn: () => search({ data: { q: term, limit: LIMIT } }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled,
  });
  return { targets: targets.data ?? [], setQuery };
}

export function BoardAssignTo({
  value,
  targets,
  disabled,
  onSearch,
  onChange,
}: {
  value: ForwardTarget | undefined;
  targets: readonly ForwardTarget[];
  disabled: boolean;
  onSearch: (term: string) => void;
  onChange: (target: ForwardTarget) => void;
}) {
  const listed =
    targets.find((each) => value && forwardTargetKey(each) === forwardTargetKey(value)) ?? value;
  const sidebarMembers = useLiveChannelRow(
    listed?.kind === "channel" ? listed.conversationId : "",
  )?.members;
  const shown =
    listed?.kind === "channel" && listed.members.length === 0 && sidebarMembers
      ? { ...listed, members: sidebarMembers }
      : listed;
  const label = shown ? assignTargetName(shown) : m.task_board_create_assign_pick();
  return (
    <EntityPicker
      trigger={
        <TaskFieldTrigger
          label={`${m.task_board_create_assign_to()}: ${label}`}
          disabled={disabled}
        >
          {shown ? (
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-primary">
              <Face face={faceOf(shown)} />
              <span className="truncate">{label}</span>
            </span>
          ) : (
            <span className="text-sm text-tertiary">{label}</span>
          )}
        </TaskFieldTrigger>
      }
      label={m.task_board_create_assign_to()}
      searchPlaceholder={m.task_board_create_assign_search()}
      onSearchChange={onSearch}
      selectedKey={value ? forwardTargetKey(value) : null}
      options={targets
        .filter((target) => target.canSend)
        .map((target) => ({
          id: forwardTargetKey(target),
          label: assignTargetName(target),
          face: faceOf(target),
          ...(target.kind === "agent" && agentHandle(target.handle)),
        }))}
      onSelect={(key) => {
        const target = targets.find((each) => forwardTargetKey(each) === key);
        if (target) onChange(target);
      }}
    />
  );
}
