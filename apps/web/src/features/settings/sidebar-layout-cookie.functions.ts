import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { parseSidebarLayoutCookie } from "./sidebar-layout-cookie";

export const loadSidebarLayout = createIsomorphicFn()
  .server(() => parseSidebarLayoutCookie(getRequest().headers.get("cookie") ?? undefined))
  .client(() => parseSidebarLayoutCookie(document.cookie));
