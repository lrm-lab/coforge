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
      <div className="flex flex-1 items-center justify-center py-6">
        <LoginArt />
      </div>
      <p className="text-display-xs font-medium">
        {m.landing_headline_line_1()}
        <br />
        {m.landing_headline_line_2()}
      </p>
      {/* Every code agent the Daemon runs (Frank, 11-09), from the one table the runtime picker
          reads, so a runtime added there shows here too. Twelve names read as a crowd (jing, 11-10):
          their marks overlap in one row, each named on hover, and one line names the best known. */}
      <div className="mt-6 flex flex-col items-start gap-2.5">
        <ul className="flex shrink-0">
          {RUNTIME_PROVIDER_DISPLAY_ORDER.map((provider) => (
            <li key={provider} className="-ml-1.5 first:ml-0">
              <Tooltip title={runtimeProviderLabel(provider)}>
                <Focusable>
                  <span
                    tabIndex={0}
                    aria-label={runtimeProviderLabel(provider)}
                    className="flex size-8 items-center justify-center rounded-full bg-white ring-2 ring-[#EEEBFE] outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
                  >
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
