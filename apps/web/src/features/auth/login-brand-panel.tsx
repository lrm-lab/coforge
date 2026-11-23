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

export function LoginBrandPanel() {
  return (
    <div className="login-brand-panel relative hidden flex-col bg-login-panel pr-12 pb-10 pl-[calc(var(--login-pair-gutter)+5rem)] text-gray-600 xl:flex">
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
      <div className="mt-6 flex flex-col items-start gap-2.5">
        <ul className="flex shrink-0">
          {RUNTIME_PROVIDER_DISPLAY_ORDER.map((provider) => (
            <li key={provider} className="-ml-1.5 first:ml-0">
              <Tooltip title={runtimeProviderLabel(provider)}>
                <Focusable>
                  <span
                    tabIndex={0}
                    aria-label={runtimeProviderLabel(provider)}
                    className="flex size-8 items-center justify-center rounded-full bg-white ring-2 ring-bg-login-panel outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
                  >
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
