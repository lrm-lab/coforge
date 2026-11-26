import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_LAYOUT_COOKIE,
  parseSidebarLayoutCookie,
  serializeSidebarLayoutCookie,
} from "./sidebar-layout-cookie";

describe("sidebar layout cookie", () => {
  test("parses expanded state and clamped rem width from cookie header", () => {
    expect(parseSidebarLayoutCookie(`${SIDEBAR_LAYOUT_COOKIE}=hide`)).toEqual({
      expanded: false,
    });
    expect(parseSidebarLayoutCookie(`${SIDEBAR_LAYOUT_COOKIE}=show%3A18.5`)).toEqual({
      expanded: true,
      widthRem: 18.5,
    });
    expect(parseSidebarLayoutCookie(`other=1; ${SIDEBAR_LAYOUT_COOKIE}=hide%3A25`)).toEqual({
      expanded: false,
      widthRem: 20,
    });
    expect(parseSidebarLayoutCookie(`${SIDEBAR_LAYOUT_COOKIE}=hide%3A288`)).toEqual({
      expanded: false,
      widthRem: 18,
    });
    expect(parseSidebarLayoutCookie(`${SIDEBAR_LAYOUT_COOKIE}=%3A12`)).toEqual({
      widthRem: 12,
    });
    expect(parseSidebarLayoutCookie(`${SIDEBAR_LAYOUT_COOKIE}=garbage`)).toEqual({});
    expect(parseSidebarLayoutCookie(undefined)).toEqual({});
  });

  test("serializes compact clamped cookie value", () => {
    expect(serializeSidebarLayoutCookie({ expanded: false, widthRem: 17.25 }, false)).toContain(
      `${SIDEBAR_LAYOUT_COOKIE}=hide%3A17.25; Path=/;`,
    );
    expect(serializeSidebarLayoutCookie({ expanded: true }, true)).toContain("Secure");
    expect(serializeSidebarLayoutCookie({}, false)).toBeNull();
  });
});
