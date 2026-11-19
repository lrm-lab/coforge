import type { FC, ReactElement } from "react";
import { Dropdown } from "#src/components/base/dropdown/dropdown";

export interface CascadeMenuItem {
  readonly id?: string;
  readonly label: string;
  readonly icon?: FC<{ className?: string }>;
  readonly monochromeIcon?: boolean;
  readonly href?: string;
  readonly children?: readonly CascadeMenuItem[];
}

export interface CascadeMenuProps {
  readonly anchor: ReactElement;
  readonly items: readonly CascadeMenuItem[];
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly debugSafeZone?: boolean;
  readonly onSelect?: (item: CascadeMenuItem) => void;
}

function renderItems(
  items: readonly CascadeMenuItem[],
  prefix: string,
  onSelect?: (item: CascadeMenuItem) => void,
) {
  return items.map((item, index) => {
    const key = item.id ?? `${prefix}-${index}-${item.label}`;
    const hasChildren = Boolean(item.children && item.children.length > 0);
    if (hasChildren) {
      return (
        <Dropdown.SubmenuTrigger key={key}>
          <Dropdown.Item
            id={key}
            label={item.label}
            icon={item.icon}
            folderIcon={!item.icon}
            monochromeIcon={item.monochromeIcon}
          />
          <Dropdown.SubmenuPopover title={item.label}>
            <Dropdown.Menu aria-label={item.label}>
              {renderItems(item.children!, key, onSelect)}
            </Dropdown.Menu>
          </Dropdown.SubmenuPopover>
        </Dropdown.SubmenuTrigger>
      );
    }

    return (
      <Dropdown.Item
        key={key}
        id={key}
        label={item.label}
        icon={item.icon}
        monochromeIcon={item.monochromeIcon}
        href={item.href}
        onAction={onSelect ? () => onSelect(item) : undefined}
      />
    );
  });
}

export function CascadeMenu({
  anchor,
  items,
  title,
  ariaLabel,
  debugSafeZone = false,
  onSelect,
}: CascadeMenuProps) {
  return (
    <Dropdown.Root debugSafeZone={debugSafeZone}>
      {anchor}
      <Dropdown.Popover placement="bottom start" title={title}>
        <Dropdown.Menu aria-label={ariaLabel ?? title ?? "Menu"}>
          {renderItems(items, "root", onSelect)}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
