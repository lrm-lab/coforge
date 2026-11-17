import { describe, expect, test } from "bun:test";
import { FIELD_STATES } from "#src/components/base/input/field-states";
import { cx } from "#src/utils/cx";

describe("FIELD_STATES class merging", () => {
  test("shared TextArea keeps native [&:focus] typing ring bypassing [data-rac] focus gating", () => {
    const preHydration = cx(FIELD_STATES.box, FIELD_STATES.text, FIELD_STATES.focusTyping);
    expect(preHydration).toContain("ring-1");
    expect(preHydration).toContain("ring-field-border");
    expect(preHydration).toContain("[&:focus]:ring-2");
    expect(preHydration).toContain("[&:focus]:ring-field-border-typing");
  });

  test("focused TextArea upgrades resting ring-1 to typing ring-2", () => {
    const focused = cx(
      FIELD_STATES.box,
      FIELD_STATES.text,
      FIELD_STATES.focusTyping,
      FIELD_STATES.typing,
    );
    expect(focused).not.toContain("ring-1");
    expect(focused).toContain("ring-2");
    expect(focused).toContain("ring-field-border-typing");
  });

  test("shared Input keeps native [&:focus-within] typing ring", () => {
    const group = cx(FIELD_STATES.box, FIELD_STATES.focusWithinTyping);
    expect(group).toContain("[&:focus-within]:ring-2");
    expect(group).toContain("[&:focus-within]:ring-field-border-typing");
  });
});
