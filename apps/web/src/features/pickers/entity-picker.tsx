import { useState, type ReactNode } from "react";
import { useFilter } from "react-aria";
import {
  Autocomplete as AriaAutocomplete,
  Button as AriaButton,
  Input as AriaInput,
  SearchField as AriaSearchField,
} from "react-aria-components";
import { ChevronDown, Folder, SearchLg } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { HintText } from "#src/components/base/input/hint-text";
import { Label } from "#src/components/base/input/label";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { ProjectImage } from "#src/features/projects/project-image";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/**
 * One picker for every "choose a person, an Agent or a Project" in the app (task #415): a channel's
 * coordinator, a channel's Project, a Task's owner, the search page's From, and the like. A row is
 * a face and a name; an Agent adds its `@handle`, since a person and an Agent may share a name.
 * A list longer than a glance gets a search field, and a search that matches nothing says so.
 * The fixed choices a place offers ("None", "Anyone", "Unassigned") are rows like any other.
 */

/** What a row shows on its left. */
export type PickerFace =
  | { kind: "identity"; name: string; src?: string | null }
  | { kind: "project"; name: string; src?: string | null };

export type PickerOption = {
  /** Unique in the list. Namespace ids by kind (`user:…`, `agent:…`): ids of different kinds may
   * collide, and so may names. */
  id: string;
  label: string;
  face?: PickerFace;
  /** Faint at the end of the row: an Agent's `@handle`. */
  addon?: string;
  /** Matched by the search besides the label: an Agent's handle, a Project's slug. */
  keywords?: string;
  isDisabled?: boolean;
};

/** Up to this many rows are read at a glance; past it the list gets a search field. */
const SEARCH_FROM = 8;

/** A person's or Agent's picture (an Agent's mascot drawn whole, not clipped to a tile), or a
 * Project's image or folder. */
function Face({ face }: { face: PickerFace }) {
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
    <IdentityAvatar
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
};

/** The popover's content: a search field once the list is long, then the rows. */
export function PickerMenu({
  label,
  options,
  ...choice
}: MenuBase & (SingleChoice | MultipleChoice)) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  const multiple = "selectedKeys" in choice;
  // In a list with faces, a row without one ("None", "Unassigned") keeps the face's room, so every
  // name starts at one edge and every tick sits at the other.
  const faced = options.some((option) => option.face);
  const menu = (
    <Dropdown.Menu
      aria-label={label}
      className="max-h-72"
      disabledKeys={options.filter((option) => option.isDisabled).map((option) => option.id)}
      renderEmptyState={() => (
        <p className="px-3 py-2 text-sm text-tertiary">{m.picker_no_matches()}</p>
      )}
      {...(multiple
        ? {
            selectionMode: "multiple",
            selectedKeys: choice.selectedKeys,
            shouldCloseOnSelect: false,
            onSelectionChange: (keys) => {
              if (keys !== "all") choice.onSelectedKeysChange([...keys].map(String));
            },
          }
        : {
            selectionMode: "single",
            selectedKeys: choice.selectedKey === null ? [] : [choice.selectedKey],
            // Choosing what is already chosen changes nothing, as a select would not.
            onAction: (key) => {
              if (key !== choice.selectedKey) choice.onSelect(String(key));
            },
          })}
    >
      {options.map((option) => (
        <Dropdown.Item
          key={option.id}
          id={option.id}
          label={option.label}
          textValue={option.keywords ? `${option.label} ${option.keywords}` : option.label}
          leading={option.face ? <Face face={option.face} /> : faced && <span aria-hidden="true" />}
          addon={option.addon}
          selectionIndicator={multiple ? "checkbox" : undefined}
        />
      ))}
    </Dropdown.Menu>
  );
  if (options.length < SEARCH_FROM) return menu;
  return (
    <AriaAutocomplete filter={contains} inputValue={search} onInputChange={setSearch}>
      <div className="border-b border-secondary py-1">
        <AriaSearchField aria-label={label} value={search} onChange={setSearch} autoFocus>
          <div className="flex items-center gap-2 px-3 py-2">
            <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
            <AriaInput
              placeholder={m.picker_search()}
              className="w-full bg-transparent text-sm text-primary outline-hidden placeholder:text-placeholder"
            />
          </div>
        </AriaSearchField>
      </div>
      {menu}
    </AriaAutocomplete>
  );
}

type MenuProps = MenuBase & SingleChoice;

/** A picker opened from a trigger of the caller's (a chip, a Task field): the trigger, then the
 * menu in a popover under it. */
export function EntityPicker({
  trigger,
  ...menu
}: MenuProps & {
  /** A React Aria pressable: it opens the menu. */
  trigger: ReactNode;
}) {
  return (
    <Dropdown.Root>
      {trigger}
      <Dropdown.Popover placement="bottom start" className="w-72">
        <PickerMenu {...menu} />
      </Dropdown.Popover>
    </Dropdown.Root>
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
      <Dropdown.Root>
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
        <Dropdown.Popover placement="bottom start" className="w-(--trigger-width)">
          <PickerMenu {...menu} />
        </Dropdown.Popover>
      </Dropdown.Root>
      {hint && <HintText>{hint}</HintText>}
    </div>
  );
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
    face: { kind: "identity", name: member.label, src: member.avatarUrl },
    ...(member.kind === "agent" && { addon: `@${member.handle}`, keywords: member.handle }),
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
