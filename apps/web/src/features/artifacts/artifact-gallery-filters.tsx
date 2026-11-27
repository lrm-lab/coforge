import { useRef, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button as AriaButton } from "react-aria-components";
import {
  CheckCircle,
  ChevronDown,
  Globe02,
  Grid01,
  List,
  MessageChatCircle,
  Star01,
  SwitchVertical01,
  User01,
  Users01,
  XClose,
} from "@untitledui/icons";

import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "#src/features/conversations/conversation-queries";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import { EntityPicker, type PickerOption } from "#src/features/pickers/entity-picker";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useSlidingIndicator } from "#src/hooks/use-sliding-indicator";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type {
  GalleryFilters,
  GalleryScope,
  GallerySort,
  GalleryStatus,
  GalleryView,
} from "./artifact-gallery-model";
import { useScopeLabels } from "./artifact-scope";
import { useConversationName } from "./use-conversation-name";

const chipClass = (active: boolean) =>
  cn(
    "flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium outline-focus-ring ring-1 ring-inset focus-visible:outline-2",
    active
      ? "bg-active text-primary ring-primary"
      : "text-tertiary ring-secondary hover:bg-primary_hover",
  );

function ChipTrigger({
  icon: Icon,
  label,
  active,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  active: boolean;
}) {
  return (
    <AriaButton className={chipClass(active)}>
      <Icon aria-hidden={true} className="size-4 shrink-0 text-fg-quaternary" />
      <span className="max-w-48 truncate">{label}</span>
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
    </AriaButton>
  );
}

function ClearButton({ onClear }: { onClear: () => void }) {
  return (
    <AriaButton
      aria-label={m.ag_clear_filters()}
      className="-ml-1 cursor-pointer rounded-md p-1 text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2"
      onPress={onClear}
    >
      <XClose aria-hidden="true" className="size-3.5" />
    </AriaButton>
  );
}

const ROOM_PREFIX = "conversation:";
const roomKey = (conversationId: string) => `${ROOM_PREFIX}${conversationId}`;
const scopeOf = (key: string): GalleryScope =>
  key === "link" || key === "workspace"
    ? { kind: key }
    : { kind: "conversation", conversationId: key.slice(ROOM_PREFIX.length) };

export function ConversationFilter({
  scope,
  onChange,
}: {
  scope: GalleryScope | undefined;
  onChange: (scope: GalleryScope | undefined) => void;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const channels = useQuery(channelNamesQuery(workspaceId)).data ?? [];
  const directory = useWorkspaceDirectory().data;
  const nameOf = useConversationName();
  const labels = useScopeLabels();
  const label =
    scope === undefined
      ? m.ag_filter_conversation()
      : scope.kind === "conversation"
        ? (nameOf(scope.conversationId) ?? m.ag_filter_conversation())
        : labels[scope.kind];
  const visibility: PickerOption[] = [
    { id: "link", label: labels.link, face: { kind: "icon", icon: <Globe02 /> } },
    { id: "workspace", label: labels.workspace, face: { kind: "icon", icon: <Users01 /> } },
  ];
  const roomOptions = new Map<string, PickerOption>();
  for (const channel of channels)
    roomOptions.set(channel.id, {
      id: roomKey(channel.id),
      label: channel.name,
      ariaLabel: `#${channel.name}`,
      keywords: `#${channel.name}`,
      face: { kind: "channel", visibility: channel.visibility, members: channel.members },
    });
  for (const person of directory?.people ?? []) {
    const conversationId = person.dmId;
    if (!conversationId || roomOptions.has(conversationId)) continue;
    roomOptions.set(conversationId, {
      id: roomKey(conversationId),
      label: person.name,
      keywords: `@${person.name}`,
      face: { kind: "identity", name: person.name, src: person.avatarUrl, userId: person.id },
    });
  }
  for (const agent of directory?.agents ?? []) {
    const conversationId = agent.dmId;
    if (!conversationId || roomOptions.has(conversationId)) continue;
    roomOptions.set(conversationId, {
      id: roomKey(conversationId),
      label: agent.name,
      keywords: `@${agent.name}`,
      face: { kind: "identity", name: agent.name, agentId: agent.id },
    });
  }
  const rooms = [...roomOptions.values()];
  return (
    <div className="flex shrink-0 items-center">
      <EntityPicker
        label={m.ag_filter_conversation()}
        searchPlaceholder={m.ag_search_conversations()}
        className="w-72"
        selectedKey={
          scope === undefined
            ? null
            : scope.kind === "conversation"
              ? roomKey(scope.conversationId)
              : scope.kind
        }
        sections={[
          { id: "visibility", label: m.ag_group_visibility(), options: visibility },
          { id: "conversations", label: m.ag_group_conversations(), options: rooms },
        ]}
        onSelect={(key) => onChange(scopeOf(key))}
        trigger={
          <ChipTrigger
            icon={MessageChatCircle}
            label={scope ? m.ag_conversation_chip({ name: label }) : label}
            active={scope !== undefined}
          />
        }
      />
      {scope !== undefined && <ClearButton onClear={() => onChange(undefined)} />}
    </div>
  );
}

export function AuthorFilter({
  authorIds,
  onChange,
}: {
  authorIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const agents = useWorkspaceDirectory().data?.agents ?? [];
  const options: PickerOption[] = agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    face: { kind: "identity", name: agent.name, agentId: agent.id },
  }));
  const names = authorIds
    .map((id) => agents.find((agent) => agent.id === id)?.name ?? "")
    .filter(Boolean);
  const shownNames = names.slice(0, 2).join(", ");
  const overflow = names.length - 2;
  const label =
    names.length === 0
      ? m.ag_filter_author()
      : m.ag_author_chip({
          names: overflow > 0 ? `${shownNames} +${overflow}` : shownNames,
        });
  return (
    <div className="flex shrink-0 items-center">
      <EntityPicker
        label={m.ag_filter_author()}
        searchPlaceholder={m.ag_search_authors()}
        options={options}
        selectedKeys={authorIds}
        onSelectedKeysChange={onChange}
        trigger={<ChipTrigger icon={User01} label={label} active={authorIds.length > 0} />}
      />
      {authorIds.length > 0 && <ClearButton onClear={() => onChange([])} />}
    </div>
  );
}

const STATUS_OPTIONS: readonly GalleryStatus[] = ["unsettled", "all", "settled"];

const STATUS_LABELS: Record<GalleryStatus, () => string> = {
  unsettled: m.ag_status_unsettled,
  all: m.ag_status_all,
  settled: m.ag_status_settled,
};

export function StatusFilter({
  status,
  onChange,
}: {
  status: GalleryStatus;
  onChange: (status: GalleryStatus) => void;
}) {
  const label = m.ag_status_label({ status: STATUS_LABELS[status]() });
  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={label}
        data-artifact-status-filter=""
        className={chipClass(status !== "all")}
      >
        <CheckCircle aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
        <span className="max-w-48 truncate">{label}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </AriaButton>
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu
          aria-label={label}
          selectionMode="single"
          selectedKeys={[status]}
          disallowEmptySelection
          onAction={(key) => onChange(key as GalleryStatus)}
        >
          {STATUS_OPTIONS.map((option) => (
            <Dropdown.Item
              key={option}
              id={option}
              data-artifact-status-option={option}
              label={STATUS_LABELS[option]()}
            />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function RelatedToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <AriaButton aria-pressed={on} className={chipClass(on)} onPress={() => onChange(!on)}>
      <Star01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
      <span>{m.ag_related()}</span>
    </AriaButton>
  );
}

export function SortMenu({
  sort,
  onChange,
}: {
  sort: GalleryFilters["sort"];
  onChange: (sort: GallerySort) => void;
}) {
  const words = useBreakpoint("sm");
  return (
    <Dropdown.Root>
      <AriaButton aria-label={m.ag_sort()} className={chipClass(false)}>
        <SwitchVertical01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
        {words && <span>{sort === "opened" ? m.ag_sort_opened() : m.ag_sort_updated()}</span>}
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </AriaButton>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={m.ag_sort()}
          selectionMode="single"
          selectedKeys={[sort]}
          disallowEmptySelection
          onAction={(key) => onChange(key as GallerySort)}
        >
          <Dropdown.Item id="opened" label={m.ag_sort_opened()} />
          <Dropdown.Item id="updated" label={m.ag_sort_updated()} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function ViewSwitch({
  view,
  onChange,
}: {
  view: GalleryView;
  onChange: (view: GalleryView) => void;
}) {
  const words = useBreakpoint("sm");
  const wrapRef = useRef<HTMLDivElement>(null);
  const { indicatorRef, style, visible } = useSlidingIndicator(wrapRef, {
    activeKey: view,
    variant: "pill",
  });
  return (
    <div ref={wrapRef} className="relative inline-flex rounded-lg bg-primary">
      {visible && (
        <span
          ref={indicatorRef}
          aria-hidden="true"
          style={style}
          className={cn(
            "pointer-events-none absolute top-0 left-0 bg-primary_hover",
            view === "grid" ? "rounded-l-lg" : "rounded-r-lg",
          )}
        />
      )}
      <ButtonGroup
        size="sm"
        className="z-10"
        aria-label={m.ag_view_grid()}
        selectedKeys={[view]}
        disallowEmptySelection
        onSelectionChange={(keys) => {
          const [key] = [...keys];
          if (key === "grid" || key === "list") onChange(key);
        }}
      >
        <ButtonGroupItem
          id="grid"
          iconLeading={Grid01}
          aria-label={m.ag_view_grid()}
          className="bg-transparent selected:bg-transparent"
        >
          {words && m.ag_view_grid()}
        </ButtonGroupItem>
        <ButtonGroupItem
          id="list"
          iconLeading={List}
          aria-label={m.ag_view_list()}
          className="bg-transparent selected:bg-transparent"
        >
          {words && m.ag_view_list()}
        </ButtonGroupItem>
      </ButtonGroup>
    </div>
  );
}
