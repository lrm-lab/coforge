import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";

import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { LoginArtProvider } from "./login-art-state";
import { LoginBrandPanel } from "./login-brand-panel";

const PAIR = "90rem";

export function LoginSplitLayout({ children }: { children: ReactNode }) {
  return (
    <LoginArtProvider>
      <div
        className="grid min-h-dvh bg-primary safe-area-padding xl:grid-cols-[minmax(0,1fr)_auto] xl:bg-login-panel"
        style={{ "--login-pair-gutter": `max(0px, (100vw - ${PAIR}) / 2)` } as CSSProperties}
      >
        <LoginBrandPanel />
        <div className="flex flex-col px-4 py-8 md:px-8 xl:py-16 xl:pr-[calc(var(--login-pair-gutter)+4rem)] xl:pl-0">
          <Link to="/" aria-label="CoForge" className="self-start xl:hidden">
            <CoForgeMark className="h-7" />
          </Link>
          <main className="flex flex-1 items-start justify-center pt-12 pb-12 xl:rounded-[1.875rem] xl:bg-primary xl:px-[7.875rem] xl:pt-[max(2rem,calc(50dvh-22rem))] xl:pb-8">
            <div className="w-full max-w-sm xl:w-sm">{children}</div>
          </main>
        </div>
      </div>
    </LoginArtProvider>
  );
}
