import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { searchForwardDestinations } from "#src/features/conversations/message-forward.functions";
import {
  forwardTargetKey,
  forwardTargetLabel,
} from "#src/features/conversations/message-forward-model";
import type { ForwardTarget } from "#src/features/conversations/message-forward";
import { EntityPicker, Face, type PickerFace } from "#src/features/pickers/entity-picker";
import { m } from "#src/paraglide/messages";
import { TaskFieldTrigger } from "./task-field-trigger";

/** How many of each kind the picker lists; its search reaches the rest. */
const LIMIT = 50;
/** How long typing pauses before everyone is searched. */
const SEARCH_DEBOUNCE_MS = 250;

function faceOf(target: ForwardTarget): PickerFace {
  if (target.kind === "channel") return { kind: "channel", visibility: target.visibility };
  return {
    kind: "identity",
    name: target.name,
    src: target.avatarUrl,
    ...(target.kind === "person" ? { userId: target.userId } : { agentId: target.agentId }),
  };
}

/** Everyone a new Task can go to, searched on the server: a Workspace can hold more than a list
 * can send. Those the viewer cannot post to (an archived channel) stay in, so a default can be
 * judged; `BoardAssignTo` does not offer them. */
export function useAssignTargets() {
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
  });
  return { targets: targets.data ?? [], setQuery };
}

/** Who a new Task goes to: a channel, or a person or an Agent, from everyone the viewer can reach,
 * as a forward picks where a message goes. */
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
  // The list knows a channel's visibility; a default taken from the board does not.
  const shown =
    targets.find((each) => value && forwardTargetKey(each) === forwardTargetKey(value)) ?? value;
  const label = shown ? forwardTargetLabel(shown) : m.task_board_create_assign_pick();
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
          label: forwardTargetLabel(target),
          face: faceOf(target),
        }))}
      onSelect={(key) => {
        const target = targets.find((each) => forwardTargetKey(each) === key);
        if (target) onChange(target);
      }}
    />
  );
}
