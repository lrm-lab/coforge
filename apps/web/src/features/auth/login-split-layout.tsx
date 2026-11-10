import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { LoginBrandPanel } from "./login-brand-panel";

/**
 * The shell of the sign-in page: the brand panel on the left from `lg` up (always light), the form
 * on the right in the app's theme. From `lg` up the whole page is the panel's lavender and the form
 * sits on a card 4rem from the top, the bottom and the right (jing, 11-10: 64dp margins, a 30dp radius), so the form
 * reads as one piece set into the page. Below `lg` only the form is left, under the logo. The
 * invite pages keep `AuthSplitLayout`.
 */
export function LoginSplitLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-primary safe-area-padding lg:grid-cols-2 lg:bg-[#EEEBFE]">
      <LoginBrandPanel />
      <div className="flex flex-col px-4 py-8 md:px-8 lg:py-16 lg:pr-16 lg:pl-0">
        <Link to="/" aria-label="CoForge" className="self-start lg:hidden">
          <CoForgeMark className="h-7" />
        </Link>
        {/* From the top, not centred, so the title stays put when the tabs differ in height. */}
        <main className="flex flex-1 items-start justify-center pt-12 pb-12 lg:rounded-[1.875rem] lg:bg-primary lg:px-8 lg:pt-[16vh]">
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </div>
    </div>
  );
}
