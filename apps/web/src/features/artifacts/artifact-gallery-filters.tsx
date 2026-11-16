import { useState, type ReactNode } from "react";
import { Button as AriaButton, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { ChevronDown, Grid01, List, SearchLg, XClose } from "@untitledui/icons";

import { ButtonGroup, ButtonGroupItem } from "#src/components/base/button-group/button-group";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { useWorkspaceDirectory } from "#src/features/conversations/workspace-directory-query";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
import type {
  GalleryFilters,
  GalleryScope,
  GallerySort,
  GalleryView,
} from "./artifact-gallery-model";
import { useScopeLabels, visibilityIcon } from "./artifact-scope";
import { useConversationNames } from "./use-conversation-name";

const chipClass = (active: boolean) =>
  cn(
    "flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium outline-focus-ring ring-1 ring-inset focus-visible:outline-2",
    active
      ? "bg-active text-primary ring-primary"
      : "text-tertiary ring-secondary hover:bg-primary_hover",
  );

function PickerChip({
  label,
  active,
  onClear,
  children,
}: {
  label: string;
  active: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <DialogTrigger>
        <AriaButton className={chipClass(active)}>
          <span className="max-w-48 truncate">{label}</span>
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </AriaButton>
        <Popover
          placement="bottom start"
          className={cn(
            "w-72 origin-(--trigger-anchor-point) rounded-lg bg-primary shadow-lg ring-1 ring-secondary_alt",
            POPOVER_MOTION,
          )}
        >
          <Dialog aria-label={label} className="flex max-h-80 flex-col outline-hidden">
            {children}
          </Dialog>
        </Popover>
      </DialogTrigger>
      {active && (
        <AriaButton
          aria-label={m.ag_clear_filters()}
          className="-ml-1 cursor-pointer rounded-md p-1 text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2"
          onPress={onClear}
        >
          <XClose aria-hidden="true" className="size-3.5" />
        </AriaButton>
      )}
    </div>
  );
}

function PickList({
  search,
  placeholder,
  empty,
  children,
}: {
  search: string;
  placeholder: string;
  empty: string;
  children: (query: string) => ReactNode[];
}) {
  const [query, setQuery] = useState("");
  const rows = children(query.trim().toLowerCase());
  return (
    <>
      <div className="border-b border-secondary p-2">
        <Input
          size="sm"
          icon={SearchLg}
          aria-label={search}
          placeholder={placeholder}
          value={query}
          onChange={setQuery}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {rows.length === 0 ? <p className="px-3 py-2 text-sm text-tertiary">{empty}</p> : rows}
      </div>
    </>
  );
}

function GroupHeading({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-2 pb-1 text-xs font-medium text-quaternary">{children}</p>;
}

function Row({
  selected,
  onPress,
  icon,
  children,
}: {
  selected?: boolean;
  onPress: () => void;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AriaButton
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2",
        selected && "bg-active font-medium text-primary",
      )}
      onPress={onPress}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </AriaButton>
  );
}

export function ConversationFilter({
  scope,
  onChange,
}: {
  scope: GalleryScope | undefined;
  onChange: (scope: GalleryScope | undefined) => void;
}) {
  const names = useConversationNames();
  const labels = useScopeLabels();
  const label =
    scope === undefined
      ? m.ag_filter_conversation()
      : scope.kind === "conversation"
        ? (names.get(scope.conversationId) ?? m.ag_filter_conversation())
        : labels[scope.kind];
  const rooms = [...names].map(([id, name]) => ({ id, name }));
  return (
    <PickerChip
      label={scope ? m.ag_conversation_chip({ name: label }) : label}
      active={scope !== undefined}
      onClear={() => onChange(undefined)}
    >
      <PickList
        search={m.ag_search_conversations()}
        placeholder={m.ag_search_conversations()}
        empty={m.ag_no_conversations()}
      >
        {(query) => {
          const visible = [
            { kind: "link" as const, name: labels.link, icon: visibilityIcon.link },
            { kind: "workspace" as const, name: labels.workspace, icon: visibilityIcon.workspace },
          ].filter((entry) => entry.name.toLowerCase().includes(query));
          const matching = rooms.filter((room) => room.name.toLowerCase().includes(query));
          return [
            ...(visible.length > 0
              ? [<GroupHeading key="who-can-see">{m.ag_group_visibility()}</GroupHeading>]
              : []),
            ...visible.map(({ kind, name, icon: Icon }) => (
              <Row
                key={kind}
                selected={scope?.kind === kind}
                icon={<Icon aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />}
                onPress={() => onChange({ kind })}
              >
                {name}
              </Row>
            )),
            ...(matching.length > 0
              ? [<GroupHeading key="conversations">{m.ag_group_conversations()}</GroupHeading>]
              : []),
            ...matching.map((room) => (
              <Row
                key={room.id}
                selected={scope?.kind === "conversation" && scope.conversationId === room.id}
                onPress={() => onChange({ kind: "conversation", conversationId: room.id })}
              >
                {room.name}
              </Row>
            )),
          ];
        }}
      </PickList>
    </PickerChip>
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
  const names = authorIds.map((id) => agents.find((agent) => agent.id === id)?.name ?? "");
  const label =
    authorIds.length === 0
      ? m.ag_filter_author()
      : m.ag_author_chip({ names: names.slice(0, 2).join(", ") });
  return (
    <PickerChip label={label} active={authorIds.length > 0} onClear={() => onChange([])}>
      <PickList
        search={m.ag_search_authors()}
        placeholder={m.ag_search_authors()}
        empty={m.ag_no_authors()}
      >
        {(query) =>
          agents
            .filter((agent) => agent.name.toLowerCase().includes(query))
            .map((agent) => (
              <Row
                key={agent.id}
                selected={authorIds.includes(agent.id)}
                onPress={() =>
                  onChange(
                    authorIds.includes(agent.id)
                      ? authorIds.filter((id) => id !== agent.id)
                      : [...authorIds, agent.id],
                  )
                }
              >
                {agent.name}
              </Row>
            ))
        }
      </PickList>
    </PickerChip>
  );
}

export function RelatedToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <AriaButton aria-pressed={on} className={chipClass(on)} onPress={() => onChange(!on)}>
      {m.ag_related()}
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
        {words && (sort === "opened" ? m.ag_sort_opened() : m.ag_sort_updated())}
        <ChevronDown aria-hidden="true" className="size-3.5" />
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
  return (
    <ButtonGroup
      size="sm"
      aria-label={m.ag_view_grid()}
      selectedKeys={[view]}
      disallowEmptySelection
      onSelectionChange={(keys) => {
        const [key] = [...keys];
        if (key === "grid" || key === "list") onChange(key);
      }}
    >
      <ButtonGroupItem id="grid" iconLeading={Grid01} aria-label={m.ag_view_grid()}>
        {words && m.ag_view_grid()}
      </ButtonGroupItem>
      <ButtonGroupItem id="list" iconLeading={List} aria-label={m.ag_view_list()}>
        {words && m.ag_view_list()}
      </ButtonGroupItem>
    </ButtonGroup>
  );
}
