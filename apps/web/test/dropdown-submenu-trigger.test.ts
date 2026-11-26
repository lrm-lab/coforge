import { describe, expect, test } from "bun:test";
import {
  handleSubmenuItemPress,
  shouldFocusFirstSubmenuItem,
  type SubmenuPressPointerType,
} from "#src/components/base/dropdown/dropdown-submenu";
import type {
  CascadeMenuContextValue,
  CascadeSubmenuItemContextValue,
} from "#src/components/ui/cascade-menu-controller";

describe("Dropdown.SubmenuTrigger press helpers", () => {
  test("handleSubmenuItemPress distinguishes pointer vs keyboard/virtual focus, disabled state, and leaf items", () => {
    const cases: Array<[SubmenuPressPointerType, boolean]> = [
      ["mouse", false],
      ["touch", false],
      ["pen", false],
      ["virtual", true],
      ["keyboard", true],
    ];
    let suppressCalls = 0;
    const openCalls: boolean[] = [];
    let forwarded = 0;
    const cascade = {
      markSuppressRootClose: () => {
        suppressCalls += 1;
      },
    } as unknown as CascadeMenuContextValue;
    const submenuItem: CascadeSubmenuItemContextValue = {
      submenuId: "s",
      anchorName: "--s",
      isSubmenuOpen: false,
      openOnHover: false,
      triggerRef: { current: null },
      openSubmenuNow: (flag) => openCalls.push(flag),
      popover: null,
    };

    for (const [pointerType, focusFirst] of cases) {
      expect(shouldFocusFirstSubmenuItem(pointerType)).toBe(focusFirst);
      suppressCalls = 0;
      openCalls.length = 0;
      forwarded = 0;
      expect(
        handleSubmenuItemPress(
          { pointerType },
          { isDisabled: false, cascade, submenuItem, onPress: () => (forwarded += 1) },
        ),
      ).toBe(true);
      expect([suppressCalls, openCalls, forwarded]).toEqual([1, [focusFirst], 1]);
    }

    suppressCalls = 0;
    openCalls.length = 0;
    forwarded = 0;
    expect(
      handleSubmenuItemPress(
        { pointerType: "mouse" },
        { isDisabled: true, cascade, submenuItem, onPress: () => (forwarded += 1) },
      ),
    ).toBe(false);
    expect([suppressCalls, openCalls.length, forwarded]).toEqual([0, 0, 1]);

    forwarded = 0;
    expect(
      handleSubmenuItemPress(
        { pointerType: "mouse" },
        { isDisabled: false, cascade, submenuItem: null, onPress: () => (forwarded += 1) },
      ),
    ).toBe(false);
    expect([suppressCalls, forwarded]).toEqual([0, 1]);
  });
});
