import { useState, type ReactNode, type RefObject } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Button as AriaButton,
  Input as AriaInput,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  SearchField as AriaSearchField,
  type Key,
  type MenuItemProps,
  type Placement,
  type Selection,
} from "react-aria-components";
import { Check, ChevronDown, Folder } from "@untitledui/icons";

import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useBreakpoint } from "#src/hooks/use-breakpoint";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { HintText } from "#src/components/base/input/hint-text";
import { Label } from "#src/components/base/input/label";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { channelGlyph } from "#src/features/conversations/channel-name";
import type { ChannelVisibility } from "#src/features/conversations/channel-visibility";
import { ProjectImage } from "#src/features/projects/project-image";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/**
 * One picker for every "choose a person, an Agent or a Project" in the app (task #415): a channel's
 * coordinator, a channel's Project, a Task's owner, the search page's From, and the like. A row is
 * a face and a name; an Agent adds its `@handle`, since a person and an Agent may share a name.
 * The search field on top finds a row by its name or handle, and a search that matches nothing
 * says so.
 * The fixed choices a place offers ("None", "Anyone", "Unassigned") are rows like any other.
 */

/** What a row shows on its left. */
export type PickerFace =
  | {
      kind: "identity";
      name: string;
      src?: string | null;
      /** A person or an Agent: picking among people, each shows its status dot (task #510). */
      userId?: string;
      agentId?: string;
    }
  | { kind: "project"; name: string; src?: string | null }
  | { kind: "channel"; visibility: ChannelVisibility };

export type PickerOption = {
  /** Unique in the list. Namespace ids by kind (`user:…`, `agent:…`): ids of different kinds may
   * collide, and so may names. */
  id: string;
  label: string;
  face?: PickerFace;
  /** Faint at the end of the row: an Agent's `@handle`. */
  addon?: string;
  /** The row's accessible name, when its face carries meaning the label lacks (a channel's `#`). */
  ariaLabel?: string;
  /** How many there are of it (a filter's Tasks), after the addon. */
  count?: number;
  /** Matched by the search besides the label: an Agent's handle, a Project's slug. */
  keywords?: string;
  isDisabled?: boolean;
};

/** A person's or Agent's picture (an Agent's mascot drawn whole, not clipped to a tile), a
 * Project's image or folder, or a channel's `#` (a lock when it is private). */
export function Face({ face }: { face: PickerFace }) {
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

/** One choice: the popover closes on it. */
type SingleChoice = { selectedKey: string | null; onSelect: (id: string) => void };
/** Any number of choices, each a checkbox: the popover stays open while they are ticked. */
type MultipleChoice = {
  selectedKeys: readonly string[];
  onSelectedKeysChange: (ids: string[]) => void;
};

type MenuBase = {
  /** What is being chosen, as a screen reader hears the list and as the search field reads. */
  label: string;
  options: readonly PickerOption[];
  /** What the search field asks for. */
  searchPlaceholder?: string;
};

/** Every picker's search field and list, so the label picker and the member picker read alike. */
export const PICKER_SEARCH_INPUT =
  "h-10 w-full border-b border-secondary bg-transparent px-3.5 text-sm text-primary outline-hidden placeholder:text-placeholder max-sm:h-12 max-sm:text-md";
export const PICKER_LIST =
  "max-h-72 overflow-y-auto p-1 outline-hidden select-none max-sm:max-h-[50dvh]";

/** Up to this many rows are read at a glance: a list inside another menu gets a search field
 * past it. */
const SEARCH_FROM = 8;

/** The picker's content: a search field, typed into as it opens, then one row per choice. */
export function PickerMenu({
  label,
  options,
  searchPlaceholder = m.picker_search(),
  autoFocus = true,
  onClose,
  ...choice
}: MenuBase &
  (SingleChoice | MultipleChoice) & {
    /** Off on a phone, where focus would raise the keyboard over the list. */
    autoFocus?: boolean;
    /** Closes the picker that holds this menu: after a single choice, and on Esc from the search
     * field. A menu that has it is a picker of its own and always gets a search field; one inside
     * another menu (a filter's submenu) gets one only once its list is longer than a glance. */
    onClose?: () => void;
  }) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const multiple = "selectedKeys" in choice;
  // In a list with faces, a row without one ("None", "Unassigned") gets an empty ring in its place,
  // so every name starts at one edge.
  const faced = options.some((option) => option.face);
  // A handle tells apart two members of one name, and is noise otherwise (search still finds it).
  const named = new Map<string, number>();
  for (const option of options) named.set(option.label, (named.get(option.label) ?? 0) + 1);
  const list = (
    <AriaMenu
      aria-label={label}
      escapeKeyBehavior="none"
      className={PICKER_LIST}
      disabledKeys={options.filter((option) => option.isDisabled).map((option) => option.id)}
      renderEmptyState={() => (
        <p className="px-2.5 py-2 text-sm text-tertiary">{m.picker_no_matches()}</p>
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
            // Choosing what is already chosen changes nothing, as a select would not.
            onAction: (key: Key) => {
              if (key !== choice.selectedKey) choice.onSelect(String(key));
              onClose?.();
            },
          })}
    >
      {options.map((option) => (
        <PickerRow
          key={option.id}
          id={option.id}
          textValue={option.keywords ? `${option.label} ${option.keywords}` : option.label}
          aria-label={option.ariaLabel}
          leading={option.face ? <Face face={option.face} /> : faced && <NoFace />}
          multiple={multiple}
        >
          <span className="truncate">{option.label}</span>
          {option.addon && (named.get(option.label) ?? 0) > 1 && (
            <span className="shrink-0 truncate text-quaternary">{option.addon}</span>
          )}
          {option.count !== undefined && (
            <span className="ml-auto shrink-0 text-xs text-quaternary tabular-nums">
              {option.count}
            </span>
          )}
        </PickerRow>
      ))}
    </AriaMenu>
  );
  if (!onClose && options.length < SEARCH_FROM) return list;
  return (
    <AriaAutocomplete filter={contains} inputValue={search} onInputChange={setSearch}>
      {/* Esc with nothing typed closes the picker (with text, it clears the text first): the
          search field hands Esc to the list, which keeps it. */}
      <div
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && !search) onClose?.();
        }}
      >
        <AriaSearchField
          aria-label={label}
          value={search}
          onChange={setSearch}
          autoFocus={autoFocus}
        >
          <AriaInput placeholder={searchPlaceholder} className={PICKER_SEARCH_INPUT} />
        </AriaSearchField>
      </div>
      {list}
    </AriaAutocomplete>
  );
}

/** "No one" where the other rows have a face: an empty dashed ring of the same size. */
function NoFace() {
  return (
    <span
      aria-hidden="true"
      className="size-5 shrink-0 rounded-full border border-dashed border-fg-quaternary"
    />
  );
}

/**
 * One row of every picker: a face, a name on one line, and a tick at the end on the chosen one
 * (a checkbox in front where several may be chosen). Every row is the same height; the row under
 * the pointer or the arrow keys gets a faint fill, never an outline.
 */
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

type MenuProps = MenuBase & SingleChoice;

/**
 * Where a picker opens: under its trigger on a wide screen, and on a phone a sheet from the bottom
 * edge, with rows a thumb can hit and the keyboard down until the search field is tapped.
 */
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
  /** A React Aria pressable: it opens the picker. */
  trigger: ReactNode;
  /** The sheet's accessible name on a phone. */
  label: string;
  placement?: Placement;
  /** What the popover lines up with when not the trigger itself (a field's whole row). */
  anchorRef?: RefObject<Element | null>;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The popover's width on a wide screen. */
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
      {/* Edge to edge at the bottom: the official overlay's gutter and bottom room are for a card. */}
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

/** A picker opened from a trigger of the caller's (a chip, a Task field). */
export function EntityPicker({
  trigger,
  placement,
  className,
  ...menu
}: MenuProps & {
  /** A React Aria pressable: it opens the picker. */
  trigger: ReactNode;
  placement?: Placement;
  /** The popover's width on a wide screen. */
  className?: string;
}) {
  return (
    <PickerSurface trigger={trigger} label={menu.label} placement={placement} className={className}>
      {({ phone, close }) => <PickerMenu {...menu} autoFocus={!phone} onClose={close} />}
    </PickerSurface>
  );
}

/** A picker as a form field: its label, a box showing the chosen row's face and name, and a hint. */
export function EntityPickerField({
  fieldLabel,
  hint,
  placeholder,
  isDisabled,
  ...menu
}: MenuProps & {
  /** The field's visible label; `label` names the list. Absent where the form labels it. */
  fieldLabel?: string;
  hint?: string;
  placeholder?: string;
  isDisabled?: boolean;
}) {
  const chosen = menu.options.find((option) => option.id === menu.selectedKey);
  return (
    <div className="flex flex-col gap-1.5">
      {fieldLabel && <Label>{fieldLabel}</Label>}
      <PickerSurface
        label={menu.label}
        placement="bottom start"
        className="w-(--trigger-width)"
        trigger={
          <AriaButton
            isDisabled={isDisabled}
            aria-label={chosen ? `${menu.label}: ${chosen.label}` : menu.label}
            className={cn(
              "flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg bg-primary px-3 text-left shadow-xs ring-1 ring-primary outline-hidden transition duration-100 ease-linear ring-inset",
              "focus-visible:ring-2 focus-visible:ring-border-input-focus pressed:ring-2 pressed:ring-border-input-focus",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {chosen?.face && <Face face={chosen.face} />}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-md",
                chosen ? "font-medium text-primary" : "text-placeholder",
              )}
            >
              {chosen?.label ?? placeholder}
            </span>
            {chosen?.addon && (
              <span className="max-w-1/2 shrink-0 truncate text-sm text-quaternary">
                {chosen.addon}
              </span>
            )}
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 stroke-[2.25px] text-fg-quaternary"
            />
          </AriaButton>
        }
      >
        {({ phone, close }) => <PickerMenu {...menu} autoFocus={!phone} onClose={close} />}
      </PickerSurface>
      {hint && <HintText>{hint}</HintText>}
    </div>
  );
}

/** How an Agent shows and is found in a picker: its `@handle` at the row's end, searched by it. */
export function agentHandle(handle: string) {
  return { addon: `@${handle}`, keywords: handle };
}

/** A member as a picker row: keyed `user:<id>` or `agent:<id>`; an Agent shows and is searched by
 * its `@handle`, a person by name only. */
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

/** A Project as a picker row, keyed by its id: its image (or a folder), its name, searched by its
 * slug too. */
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

/** Projects as picker rows. A name two Projects share shows each one's slug, so they read apart. */
export function projectOptions(
  projects: readonly { id: string; name: string; slug?: string; iconUrl?: string | null }[],
): PickerOption[] {
  return projects.map((project) => {
    const shared = projects.some((other) => other.id !== project.id && other.name === project.name);
    return { ...projectOption(project), ...(shared && project.slug && { addon: project.slug }) };
  });
}
