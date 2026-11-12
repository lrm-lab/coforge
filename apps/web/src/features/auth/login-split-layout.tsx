import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";

import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { LoginArtProvider } from "./login-art-state";
import { LoginBrandPanel } from "./login-brand-panel";

/** Where the illustration and the card sit as a pair: up to this width they fill the page; past it
 * the pair stays this wide, centred, and the page's lavender takes the rest. */
const PAIR = "90rem";

/**
 * The shell of the sign-in page: the brand panel on the left from `xl` up (always light), the form
 * on the right in the app's theme. From `xl` up the whole page is the panel's lavender and the form
 * sits on a card 4rem from the top and the bottom (jing, 11-10: 64dp, a 30dp radius; less on a window under 39rem tall, so it still fits), with 7.875rem
 * (126dp) either side of the fields, so the card is as wide as the form and never stretches with
 * the screen. The illustration and the card are centred as a pair; up to 90rem the card keeps 4rem
 * from the right edge. Below `xl` the card would leave the illustration too little room, so only the
 * form is left, under the logo. At any common laptop height, the toolbar's share taken, the page
 * fits one screen without scrolling. The invite pages keep `AuthSplitLayout`.
 */
export function LoginSplitLayout({ children }: { children: ReactNode }) {
  return (
    <LoginArtProvider>
      <div
        className="grid min-h-dvh bg-primary safe-area-padding xl:grid-cols-[minmax(0,1fr)_auto] xl:bg-[#EEEBFE]"
        style={
          {
            "--login-pair-gutter": `max(0px, (100vw - ${PAIR}) / 2)`,
          } as CSSProperties
        }
      >
        <LoginBrandPanel />
        <div className="flex flex-col px-4 py-8 md:px-8 xl:py-[clamp(2rem,calc(50dvh-15.5rem),4rem)] xl:pr-[calc(var(--login-pair-gutter)+4rem)] xl:pl-0">
          <Link to="/" aria-label="CoForge" className="self-start xl:hidden">
            <CoForgeMark className="h-7" />
          </Link>
          {/* From the top, not centred, so the title stays put when the tabs differ in height; on
              the card the form starts about where centring would put it (it is some 25rem tall),
              and never so low that the page has to scroll (jing, 11-10: one screen). */}
          <main className="flex flex-1 items-start justify-center pt-12 pb-12 xl:rounded-[1.875rem] xl:bg-primary xl:px-[7.875rem] xl:pt-[max(2rem,calc(50dvh-16.5rem))] xl:pb-8">
            <div className="w-full max-w-sm xl:w-sm">{children}</div>
          </main>
        </div>
      </div>
    </LoginArtProvider>
  );
}
