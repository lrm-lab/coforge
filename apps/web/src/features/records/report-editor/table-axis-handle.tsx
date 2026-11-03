import type { PointerEvent as ReactPointerEvent } from "react";
import type { Editor } from "@tiptap/react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Trash01 as Trash2 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { cn } from "#src/lib/utils";
import { useT } from "./i18n";
import { deleteColumnAt, deleteRowAt, insertColumnAt, insertRowAt } from "./table-ops";
import type { ActiveTable, Axis, OpenMenu } from "./table-geometry";

type HandleProps = {
  editor: Editor;
  activeTable: ActiveTable;
  menuOpen: boolean;
  dropTarget: boolean;
  menuTablePos: number;
  setOpenMenu: (menu: OpenMenu | null) => void;
  runMenuAction: (action: () => boolean) => void;
  onHandlePointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    type: Axis,
    index: number,
  ) => void;
  onHandlePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandlePointerUp: (
    event: ReactPointerEvent<HTMLButtonElement>,
    type: Axis,
    index: number,
  ) => void;
};

function AxisHandle({ axis, active }: { axis: Axis; active?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center rounded-sm bg-quaternary transition-colors",
        axis === "row" ? "h-5 w-2 flex-col gap-[2px]" : "h-2 w-5 flex-row gap-[2px]",
        active ? "bg-secondary-solid" : "group-hover/handle:bg-secondary-solid",
      )}
    >
      <span className="size-[3px] rounded-full bg-white" />
      <span className="size-[3px] rounded-full bg-white" />
    </span>
  );
}

export function ColumnHandle({
  editor,
  activeTable,
  col,
  menuOpen,
  dropTarget,
  menuTablePos,
  setOpenMenu,
  runMenuAction,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
}: HandleProps & { col: number }) {
  const { t } = useT("editor");
  return (
    <Dropdown.Root
      isOpen={menuOpen}
      onOpenChange={(open) => {
        if (!open) setOpenMenu(null);
      }}
    >
      <AriaButton
        type="button"
        className={cn(
          "group/handle pointer-events-auto absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity",
          "hover:opacity-100 focus-visible:opacity-100 any-pointer-coarse:opacity-100",
          (menuOpen || dropTarget) && "opacity-100",
        )}
        aria-label={t(($) => $.table_controls.column_menu)}
        onPointerDown={(event) => onHandlePointerDown(event, "column", col)}
        onPointerMove={onHandlePointerMove}
        onPointerUp={(event) => onHandlePointerUp(event, "column", col)}
        onPress={(event) => {
          if (event.pointerType === "keyboard" || event.pointerType === "virtual") {
            setOpenMenu({ type: "column", index: col, tablePos: activeTable.pos });
          }
        }}
        onClick={(event) => {
          event.preventDefault();
        }}
      >
        <AxisHandle axis="column" active={menuOpen || Boolean(dropTarget)} />
      </AriaButton>
      <Dropdown.Popover
        placement="bottom"
        offset={6}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Dropdown.Menu>
          <Dropdown.Item
            label={t(($) => $.table_controls.insert_column_left)}
            icon={ArrowLeft}
            onAction={() => {
              runMenuAction(() => insertColumnAt(editor, menuTablePos, col));
            }}
          />
          <Dropdown.Item
            label={t(($) => $.table_controls.insert_column_right)}
            icon={ArrowRight}
            onAction={() => {
              runMenuAction(() => insertColumnAt(editor, menuTablePos, col + 1));
            }}
          />
          <Dropdown.Separator />
          <Dropdown.Item
            label={t(($) => $.table_controls.delete_column)}
            icon={Trash2}
            className="text-error-primary"
            onAction={() => {
              runMenuAction(() => deleteColumnAt(editor, menuTablePos, col));
            }}
          />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

export function RowHandle({
  editor,
  activeTable,
  row,
  menuOpen,
  dropTarget,
  menuTablePos,
  setOpenMenu,
  runMenuAction,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
}: HandleProps & { row: number }) {
  const { t } = useT("editor");
  return (
    <Dropdown.Root
      isOpen={menuOpen}
      onOpenChange={(open) => {
        if (!open) setOpenMenu(null);
      }}
    >
      <AriaButton
        type="button"
        className={cn(
          "group/handle pointer-events-auto absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center opacity-0 transition-opacity",
          "hover:opacity-100 focus-visible:opacity-100 any-pointer-coarse:opacity-100",
          (menuOpen || dropTarget) && "opacity-100",
        )}
        aria-label={t(($) => $.table_controls.row_menu)}
        onPointerDown={(event) => onHandlePointerDown(event, "row", row)}
        onPointerMove={onHandlePointerMove}
        onPointerUp={(event) => onHandlePointerUp(event, "row", row)}
        onPress={(event) => {
          if (event.pointerType === "keyboard" || event.pointerType === "virtual") {
            setOpenMenu({ type: "row", index: row, tablePos: activeTable.pos });
          }
        }}
        onClick={(event) => {
          event.preventDefault();
        }}
      >
        <AxisHandle axis="row" active={menuOpen || Boolean(dropTarget)} />
      </AriaButton>
      <Dropdown.Popover
        placement="left top"
        offset={6}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Dropdown.Menu>
          <Dropdown.Item
            label={t(($) => $.table_controls.insert_row_above)}
            icon={ArrowUp}
            onAction={() => {
              runMenuAction(() => insertRowAt(editor, menuTablePos, row));
            }}
          />
          <Dropdown.Item
            label={t(($) => $.table_controls.insert_row_below)}
            icon={ArrowDown}
            onAction={() => {
              runMenuAction(() => insertRowAt(editor, menuTablePos, row + 1));
            }}
          />
          <Dropdown.Separator />
          <Dropdown.Item
            label={t(($) => $.table_controls.delete_row)}
            icon={Trash2}
            className="text-error-primary"
            onAction={() => {
              runMenuAction(() => deleteRowAt(editor, menuTablePos, row));
            }}
          />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
