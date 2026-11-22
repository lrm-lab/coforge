import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Header as AriaHeader,
  Input as AriaInput,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  Section as AriaMenuSection,
  SearchField as AriaSearchField,
  type Key,
  type MenuItemProps,
  type Placement,
  type Selection,
} from "react-aria-components";
import { Check, Folder } from "@untitledui/icons";

import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { EmptyState } from "#src/components/ui/empty";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { channelGlyph } from "#src/features/conversations/channel-name";
import type { ChannelVisibility } from "#src/features/conversations/channel-visibility";
import { ProjectImage } from "#src/features/projects/project-image";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { GroupAvatar, type GroupAvatarMember } from "#src/features/conversations/group-avatar";

export type PickerFace =
  | {
      kind: "identity";
      name: string;
      src?: string | null;
      userId?: string;
      agentId?: string;
    }
  | { kind: "project"; name: string; src?: string | null }
  | { kind: "icon"; icon: ReactNode }
  | {
      kind: "channel";
      visibility: ChannelVisibility;
      members?: readonly GroupAvatarMember[];
    };

export type PickerOption = {
  id: string;
  label: string;
  face?: PickerFace;
  addon?: string;
  note?: string;
  ariaLabel?: string;
  count?: number;
  keywords?: string;
  isDisabled?: boolean;
};

export function Face({ face }: { face: PickerFace }) {
  if (face.kind === "channel" && face.members?.length)
    return <GroupAvatar members={face.members} className="avatar-group-xs" />;
  if (face.kind === "channel") {
    const Glyph = channelGlyph(face);
    return (
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-md bg-tertiary text-fg-quaternary"
      >
        <Glyph className="size-3.5" />
      </span>
    );
  }
  if (face.kind === "icon")
    return (
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-md bg-tertiary text-fg-quaternary [&>svg]:size-3.5"
      >
        {face.icon}
      </span>
    );
  if (face.kind === "project")
    return (
      <ProjectImage
        name={face.name}
        url={face.src ?? null}
        fallback={<Folder className="size-3.5 text-fg-quaternary" />}
        className="size-5 rounded-sm"
      />
    );
  return (
    <ActorAvatar
      presence
      userId={face.userId}
      agentId={face.agentId}
      size="xs"
      src={face.src ?? undefined}
      name={face.name}
      alt=""
      className="size-5"
    />
  );
}

type SingleChoice = { selectedKey: string | null; onSelect: (id: string) => void };
type MultipleChoice = {
  selectedKeys: readonly string[];
  onSelectedKeysChange: (ids: string[]) => void;
};

export type PickerSection = {
  id: string;
  label: string;
  options: readonly PickerOption[];
};

type MenuBase = {
  label: string;
  options?: readonly PickerOption[];
  sections?: readonly PickerSection[];
  searchPlaceholder?: string;
  onSearchChange?: (term: string) => void;
};

export type PickerSingleProps = MenuBase & SingleChoice;
export type PickerMultipleProps = MenuBase & MultipleChoice;

export const PICKER_SEARCH_INPUT =
  "h-10 w-full border-b border-secondary bg-transparent px-3.5 text-sm text-primary outline-hidden placeholder:text-placeholder max-sm:h-12 max-sm:text-md";
export const PICKER_LIST =
  "max-h-72 overflow-y-auto p-1 outline-hidden select-none max-sm:max-h-[50dvh]";
const PICKER_SECTION_HEADING =
  "px-2.5 pt-2 pb-1 text-xs font-medium text-quaternary max-sm:pt-2.5 max-sm:text-sm";

const SEARCH_FROM = 8;

export function PickerMenu({
  label,
  options = [],
  sections,
  searchPlaceholder = m.picker_search(),
  autoFocus = true,
  onClose,
  onSearchChange,
  ...choice
}: MenuBase &
  (SingleChoice | MultipleChoice) & {
    autoFocus?: boolean;
    onClose?: () => void;
  }) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  useEffect(() => () => onSearchChange?.(""), [onSearchChange]);
  const multiple = "selectedKeys" in choice;
  const all = sections ? sections.flatMap((section) => section.options) : options;
  const faced = all.some((option) => option.face);
  const named = new Map<string, number>();
  for (const option of all) named.set(option.label, (named.get(option.label) ?? 0) + 1);
  const textOf = (option: PickerOption) =>
    option.keywords ? `${option.label} ${option.keywords}` : option.label;
  const row = (option: PickerOption) => (
    <PickerRow
      key={option.id}
      id={option.id}
      textValue={textOf(option)}
      aria-label={option.ariaLabel}
      leading={option.face ? <Face face={option.face} /> : faced && <NoFace />}
      multiple={multiple}
    >
      <span className="truncate">{option.label}</span>
      {option.addon && (named.get(option.label) ?? 0) > 1 && (
        <span className="shrink-0 truncate text-quaternary">{option.addon}</span>
      )}
      {option.note && <span className="shrink-0 text-quaternary">{option.note}</span>}
      {option.count !== undefined && (
        <span className="ml-auto shrink-0 text-xs text-quaternary tabular-nums">
          {option.count}
        </span>
      )}
    </PickerRow>
  );
  const listed = sections
    ? sections
        .map((section) => ({
          ...section,
          options:
            search && !onSearchChange
              ? section.options.filter((option) => contains(textOf(option), search))
              : section.options,
        }))
        .filter((section) => section.options.length > 0)
    : undefined;
  const list = (
    <AriaMenu
      aria-label={label}
      escapeKeyBehavior="none"
      className={PICKER_LIST}
      disabledKeys={all.filter((option) => option.isDisabled).map((option) => option.id)}
      renderEmptyState={() => (
        <EmptyState
          size="menu"
          live="polite"
          title={
            search.trim()
              ? m.empty_picker_no_matches_query({ query: search.trim() })
              : m.empty_picker_no_options()
          }
        />
      )}
      {...(multiple
        ? {
            selectionMode: "multiple" as const,
            selectedKeys: choice.selectedKeys,
            shouldCloseOnSelect: false,
            onSelectionChange: (keys: Selection) => {
              if (keys !== "all") choice.onSelectedKeysChange([...keys].map(String));
            },
          }
        : {
            selectionMode: "single" as const,
            selectedKeys: choice.selectedKey === null ? [] : [choice.selectedKey],
            shouldCloseOnSelect: !onClose,
            onAction: (key: Key) => {
              if (key !== choice.selectedKey) choice.onSelect(String(key));
              onClose?.();
            },
          })}
    >
      {listed
        ? listed.map((section) => (
            <AriaMenuSection key={section.id} id={section.id}>
              <AriaHeader className={PICKER_SECTION_HEADING}>{section.label}</AriaHeader>
              {section.options.map(row)}
            </AriaMenuSection>
          ))
        : options.map(row)}
    </AriaMenu>
  );
  if (!onClose && !onSearchChange && all.length < SEARCH_FROM) return list;
  const typed = (term: string) => {
    setSearch(term);
    onSearchChange?.(term);
  };
  return (
    <AriaAutocomplete
      {...(!onSearchChange && listed === undefined && { filter: contains })}
      inputValue={search}
      onInputChange={typed}
    >
      <div
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && !search) onClose?.();
        }}
      >
        <AriaSearchField aria-label={label} value={search} onChange={typed} autoFocus={autoFocus}>
          <AriaInput placeholder={searchPlaceholder} className={PICKER_SEARCH_INPUT} />
        </AriaSearchField>
      </div>
      {list}
    </AriaAutocomplete>
  );
}

function NoFace() {
  return (
    <span
      aria-hidden="true"
      className="size-5 shrink-0 rounded-full border border-dashed border-fg-quaternary"
    />
  );
}

export function PickerRow({
  leading,
  multiple,
  children,
  ...props
}: Omit<MenuItemProps, "children" | "className"> & {
  leading?: ReactNode;
  multiple?: boolean;
  children: ReactNode;
}) {
  return (
    <AriaMenuItem
      {...props}
      className={({ isFocused, isDisabled }) =>
        cn(
          "flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-primary outline-hidden max-sm:h-11 max-sm:text-md",
          isFocused && "bg-primary_hover",
          isDisabled && "cursor-not-allowed opacity-50",
        )
      }
    >
      {({ isSelected }) => (
        <>
          {multiple && <CheckboxBase isSelected={isSelected} size="sm" className="shrink-0" />}
          {leading}
          <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
          {!multiple && (
            <Check
              aria-hidden="true"
              className={cn("size-4 shrink-0 text-fg-secondary", !isSelected && "invisible")}
            />
          )}
        </>
      )}
    </AriaMenuItem>
  );
}

type MenuProps = PickerSingleProps | PickerMultipleProps;

export function PickerSurface({
  trigger,
  label,
  placement = "bottom start",
  anchorRef,
  isOpen,
  onOpenChange,
  className,
  children,
}: {
  trigger: ReactNode;
  label: string;
  placement?: Placement;
  anchorRef?: RefObject<Element | null>;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: (sheet: { phone: boolean; close: () => void }) => ReactNode;
}) {
  const wide = useBreakpoint("sm");
  const [ownOpen, setOwnOpen] = useState(false);
  const open = isOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const close = () => setOpen(false);
  if (wide)
    return (
      <Dropdown.Root isOpen={open} onOpenChange={setOpen}>
        {trigger}
        <Dropdown.Popover
          placement={placement}
          triggerRef={anchorRef}
          className={cn("w-64", className)}
        >
          {children({ phone: false, close })}
        </Dropdown.Popover>
      </Dropdown.Root>
    );
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      {trigger}
      <ModalOverlay isDismissable className="px-0 [--modal-pb:0px]">
        <Modal className="w-full rounded-t-2xl rounded-b-none">
          <Dialog aria-label={label} className="pb-safe-bottom outline-hidden">
            <div
              aria-hidden="true"
              className="mx-auto mt-2 mb-1 h-1 w-9 rounded-full bg-quaternary/40"
            />
            {children({ phone: true, close })}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

export function EntityPicker({
  trigger,
  placement,
  className,
  ...menu
}: MenuProps & {
  trigger: ReactNode;
  placement?: Placement;
  className?: string;
}) {
  return (
    <PickerSurface trigger={trigger} label={menu.label} placement={placement} className={className}>
      {({ phone, close }) => <PickerMenu {...menu} autoFocus={!phone} onClose={close} />}
    </PickerSurface>
  );
}

export function agentHandle(handle: string) {
  return { addon: `@${handle}`, keywords: handle };
}

export function memberOption(member: {
  kind: "user" | "agent";
  id: string;
  label: string;
  handle: string;
  avatarUrl?: string | null;
}): PickerOption {
  return {
    id: `${member.kind}:${member.id}`,
    label: member.label,
    face: {
      kind: "identity",
      name: member.label,
      src: member.avatarUrl,
      ...(member.kind === "agent" ? { agentId: member.id } : { userId: member.id }),
    },
    ...(member.kind === "agent" && agentHandle(member.handle)),
  };
}

export function projectOption(project: {
  id: string;
  name: string;
  slug?: string;
  iconUrl?: string | null;
}): PickerOption {
  return {
    id: project.id,
    label: project.name,
    face: { kind: "project", name: project.name, src: project.iconUrl },
    keywords: project.slug,
  };
}

export function projectOptions(
  projects: readonly { id: string; name: string; slug?: string; iconUrl?: string | null }[],
): PickerOption[] {
  return projects.map((project) => {
    const shared = projects.some((other) => other.id !== project.id && other.name === project.name);
    return { ...projectOption(project), ...(shared && project.slug && { addon: project.slug }) };
  });
}
