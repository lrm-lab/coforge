import { BookOpen, CircleAlert, Search } from "kubai-icons/duotone";
import { Plus } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { RecordsWireframe } from "#src/components/ui/empty-wireframes";
import * as m from "#src/paraglide/messages";

export function PersonalMemoryAgentsEmpty({
  agentQuery,
  onClear,
}: {
  agentQuery: string;
  onClear: () => void;
}) {
  if (agentQuery.trim()) {
    return (
      <EmptyState
        size="row"
        live="polite"
        className="px-0"
        title={m.empty_memory_personal_agents_no_match({ query: agentQuery.trim() })}
        primaryAction={
          <Button size="xs" color="link-gray" onPress={onClear}>
            {m.empty_clear_search()}
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState size="row" className="px-0" title={m.empty_memory_personal_no_agents_title()} />
  );
}

export function PersonalMemoryListEmpty({
  query,
  archived,
  agentName,
  onClear,
  onCreate,
}: {
  query: string;
  archived: boolean;
  agentName: string;
  onClear: () => void;
  onCreate: () => void;
}) {
  if (query.trim()) {
    return (
      <div className="px-4 py-4">
        <EmptyState
          size="card"
          live="polite"
          picture={<EmptyIcon icon={Search} size="card" />}
          title={m.empty_memory_no_match_query({ query: query.trim() })}
          primaryAction={
            <Button size="sm" color="tertiary" onPress={onClear}>
              {m.empty_clear_search()}
            </Button>
          }
        />
      </div>
    );
  }
  if (archived) {
    return (
      <div className="px-4 py-4">
        <EmptyState
          size="card"
          live="polite"
          picture={<EmptyIcon icon={Search} size="card" />}
          title={m.empty_memory_no_match_filters()}
          primaryAction={
            <Button size="sm" color="tertiary" onPress={onClear}>
              {m.empty_clear_filters()}
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <EmptyState
      className="py-8"
      picture={<RecordsWireframe accent />}
      title={m.empty_memory_personal_no_entries_title({ agent: agentName })}
      description={m.empty_memory_personal_no_entries_description()}
      primaryAction={
        <Button size="sm" color="primary" iconLeading={Plus} onPress={onCreate}>
          {m.memory_new()}
        </Button>
      }
    />
  );
}

export function PersonalMemoryErrorState({
  message,
  onRetry,
  size = "card",
}: {
  message: string;
  onRetry: () => void;
  size?: "page" | "card";
}) {
  return (
    <EmptyState
      size={size}
      role="alert"
      picture={<EmptyIcon icon={CircleAlert} size={size === "card" ? "card" : "page"} />}
      title={message}
      description={size === "page" ? m.empty_load_failed_safe() : undefined}
      primaryAction={<RetryButton size={size} onPress={onRetry} />}
    />
  );
}

export function PersonalMemoryDetailEmpty({
  hasAgents,
  hasAgentSelected,
}: {
  hasAgents: boolean;
  hasAgentSelected: boolean;
}) {
  if (!hasAgents) {
    return (
      <EmptyState
        picture={<EmptyIcon icon={BookOpen} />}
        title={m.empty_memory_personal_no_agents_title()}
        description={m.empty_memory_personal_no_agents_description()}
      />
    );
  }
  if (!hasAgentSelected) {
    return (
      <EmptyState
        picture={<EmptyIcon icon={BookOpen} />}
        title={m.empty_memory_personal_no_agent_selected_title()}
        description={m.empty_memory_personal_no_agent_selected_description()}
      />
    );
  }
  return (
    <EmptyState
      picture={<EmptyIcon icon={BookOpen} />}
      title={m.empty_memory_none_selected_title()}
      description={m.empty_memory_none_selected_description()}
    />
  );
}
