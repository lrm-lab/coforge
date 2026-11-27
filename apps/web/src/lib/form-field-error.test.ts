import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";

import { fieldHint, focusFirstInvalidField } from "./form-field-error";

describe("fieldHint", () => {
  test("returns an alert element when error text is present", () => {
    const result = fieldHint("Username is taken", "Helper copy");
    expect(isValidElement(result)).toBe(true);
    if (isValidElement<{ role?: string; children?: string }>(result)) {
      expect(result.props.role).toBe("alert");
      expect(result.props.children).toBe("Username is taken");
    }
  });

  test("falls back to helper hint when there is no error", () => {
    expect(fieldHint("", "Helper copy")).toBe("Helper copy");
    expect(fieldHint(undefined, "Helper copy")).toBe("Helper copy");
    expect(fieldHint(undefined)).toBeUndefined();
  });
});

describe("focusFirstInvalidField", () => {
  test("returns false when container is null", () => {
    expect(focusFirstInvalidField(null)).toBe(false);
  });

  test("scrolls and focuses a matching named field", () => {
    let scrolled = false;
    let focused = false;
    const input = {
      tagName: "INPUT",
      type: "text",
      tabIndex: 0,
      hasAttribute: () => false,
      closest: () => null,
      scrollIntoView: () => {
        scrolled = true;
      },
      focus: () => {
        focused = true;
      },
    };
    const container = {
      querySelector: (selector: string) => (selector.includes('name="username"') ? input : null),
    } as unknown as ParentNode;
    expect(focusFirstInvalidField(container, "username")).toBe(true);
    expect(scrolled).toBe(true);
    expect(focused).toBe(true);
  });

  test("focuses the interactive control inside a wrapper when the named input is hidden", () => {
    let scrolled = false;
    let focused = false;
    const trigger = {
      tagName: "BUTTON",
      type: "button",
      tabIndex: 0,
      hasAttribute: () => false,
      scrollIntoView: () => {
        scrolled = true;
      },
      focus: () => {
        focused = true;
      },
    };
    const hidden = {
      tagName: "INPUT",
      type: "hidden",
      hasAttribute: () => false,
      closest: () => ({
        querySelector: () => trigger,
      }),
    };
    const container = {
      querySelector: (selector: string) => (selector.includes('name="model"') ? hidden : null),
    } as unknown as ParentNode;
    expect(focusFirstInvalidField(container, "model")).toBe(true);
    expect(scrolled).toBe(true);
    expect(focused).toBe(true);
  });

  test("prefers data-field wrapper over a sibling hidden input with the same name", () => {
    let focusedTarget = "";
    const selectTrigger = {
      tagName: "BUTTON",
      type: "button",
      tabIndex: 0,
      scrollIntoView: () => {},
      focus: () => {
        focusedTarget = "provider-select";
      },
    };
    const fieldWrapper = {
      tagName: "DIV",
      tabIndex: -1,
      querySelector: () => selectTrigger,
    };
    const container = {
      querySelector: (selector: string) =>
        selector === '[data-field="provider"]' ? fieldWrapper : null,
    } as unknown as ParentNode;
    expect(focusFirstInvalidField(container, "provider")).toBe(true);
    expect(focusedTarget).toBe("provider-select");
  });
});
