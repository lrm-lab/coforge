import { Link } from "@tanstack/react-router";

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
      <div className="flex flex-1 items-center justify-center py-8">
        <LoginArt />
      </div>
      <p className="text-display-xs font-medium">
        {m.landing_headline_line_1()}
        <br />
        {m.landing_headline_line_2()}
      </p>
      {/* Every code agent the Daemon runs (Frank, 11-09), from the one table the runtime picker
          reads, so a runtime added there shows here too. They wrap onto a second line. */}
      <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-3 text-sm">
        {RUNTIME_PROVIDER_DISPLAY_ORDER.map((provider) => (
          <li key={provider} className="inline-flex items-center gap-2">
            {/* A single-colour mark takes the panel's own grey: the panel stays light in dark mode. */}
            <RuntimeProviderMark provider={provider} className="size-5" glyphColor="bg-gray-600" />
            {runtimeProviderLabel(provider)}
          </li>
        ))}
      </ul>
    </div>
  );
}
