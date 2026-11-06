import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { LoginBrandPanel } from "./login-brand-panel";

/**
 * The shell of the sign-in page: the brand panel on the left from `lg` up (always light), the form
 * on the right in the app's theme. Below `lg` only the form is left, under the logo. The invite
 * pages keep `AuthSplitLayout`.
 */
export function LoginSplitLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-primary safe-area-padding lg:grid-cols-2">
      <LoginBrandPanel />
      <div className="flex flex-col px-4 py-8 md:px-8">
        <Link to="/" aria-label="CoForge" className="self-start lg:hidden">
          <CoForgeMark className="h-7" />
        </Link>
        <main className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </div>
    </div>
  );
}
