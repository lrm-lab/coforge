import { Link } from "@tanstack/react-router";

import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { Focusable } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";

import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import {
  RUNTIME_PROVIDER_DISPLAY_ORDER,
  runtimeProviderLabel,
} from "#src/features/agents/runtime-provider-display";
import { m } from "#src/paraglide/messages";
import { LoginArt } from "./login-art";

/** The four shown by name on the panel; the line under them names the first two. */
const LEADING = [
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.CURSOR,
  RUNTIME_PROVIDER.OPENCODE,
] as const;
const REST = RUNTIME_PROVIDER_DISPLAY_ORDER.filter(
  (provider) => !(LEADING as readonly string[]).includes(provider),
);
const CHIP =
  "flex h-8 min-w-8 items-center justify-center rounded-full bg-white outline-none focus-visible:outline-2 focus-visible:outline-focus-ring";

/**
 * The sign-in page's left half, from `xl` up: the logo, the illustration, the tagline and the
 * agents CoForge works with. Past 90rem its content moves in by the
 * layout's gutter, so it stays paired with the card. A brand panel, light in both themes, so its colours are fixed rather
 * than semantic tokens (which turn dark with the app).
 */
export function LoginBrandPanel() {
  return (
    <div className="login-brand-panel relative hidden flex-col bg-[#EEEBFE] pr-12 pb-10 pl-[calc(var(--login-pair-gutter)+5rem)] text-gray-600 xl:flex">
      {/* Placed by `login-art.css` to match the homepage's logo, above the panel's top inset. */}
      <Link to="/" aria-label="CoForge" className="login-brand-logo">
        <img src="/login/homepage-logo.webp" alt="" className="h-auto w-full" />
      </Link>
      <div className="flex flex-1 items-center justify-center py-[min(1.5rem,2dvh)]">
        <LoginArt />
      </div>
      <p className="text-display-xs font-medium">
        {m.landing_headline_line_1()}
        <br />
        {m.landing_headline_line_2()}
      </p>
      {/* Every code agent the Daemon runs (Frank, 11-09), from the one table the runtime picker
          reads, so a runtime added there shows here too. Twelve marks read as a crowd (jing, 11-10
          and 11-12): the best known four show, the rest wait behind their count, named on hover. */}
      <div className="mt-6 flex flex-col items-start gap-2.5">
        <ul className="flex shrink-0 items-center gap-1.5">
          {LEADING.map((provider) => (
            <li key={provider}>
              <Tooltip title={runtimeProviderLabel(provider)}>
                <Focusable>
                  <span tabIndex={0} aria-label={runtimeProviderLabel(provider)} className={CHIP}>
                    {/* A single-colour mark takes the panel's own grey: the panel stays light in dark mode. */}
                    <RuntimeProviderMark
                      provider={provider}
                      className="size-4"
                      glyphColor="bg-gray-600"
                    />
                  </span>
                </Focusable>
              </Tooltip>
            </li>
          ))}
          <li>
            <Tooltip title={REST.map(runtimeProviderLabel).join(" · ")}>
              <Focusable>
                <span
                  tabIndex={0}
                  aria-label={REST.map(runtimeProviderLabel).join(", ")}
                  className={`${CHIP} px-2 text-xs font-medium tabular-nums`}
                >
                  +{REST.length}
                </span>
              </Focusable>
            </Tooltip>
          </li>
        </ul>
        <p className="text-sm text-gray-500">
          {m.login_agents_supported({
            first: runtimeProviderLabel(RUNTIME_PROVIDER.CLAUDE_CODE),
            second: runtimeProviderLabel(RUNTIME_PROVIDER.CODEX),
            count: RUNTIME_PROVIDER_DISPLAY_ORDER.length,
          })}
        </p>
      </div>
    </div>
  );
}
