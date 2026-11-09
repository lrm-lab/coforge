import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex-color.svg";
import cursorMark from "@lobehub/icons-static-svg/icons/cursor.svg";
import kiroMark from "@lobehub/icons-static-svg/icons/kiro-color.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";
import { Link } from "@tanstack/react-router";

import { m } from "#src/paraglide/messages";
import { LoginArt } from "./login-art";

// Marks come from LobeHub's static icon set, as on the homepage. Codex, Claude Code and Kiro have
// colour versions; Pi and Cursor only have a single-colour mark, drawn in the text colour.
const platforms = [
  { name: "Claude Code", mark: claudeCodeMark, monochrome: false },
  { name: "Codex", mark: codexMark, monochrome: false },
  { name: "Pi", mark: piMark, monochrome: true },
  { name: "Kiro", mark: kiroMark, monochrome: false },
  { name: "Cursor", mark: cursorMark, monochrome: true },
] as const;

function PlatformMark({ mark, monochrome }: { mark: string; monochrome: boolean }) {
  if (!monochrome) return <img src={mark} alt="" className="size-5 shrink-0" />;
  return (
    <span
      aria-hidden="true"
      className="size-5 shrink-0 bg-current mask-contain mask-center mask-no-repeat"
      // Vite inlines small SVGs as data URLs that contain quotes, so the url() must be quoted.
      style={{ maskImage: `url("${mark}")`, WebkitMaskImage: `url("${mark}")` }}
    />
  );
}

/**
 * The sign-in page's left half, from `lg` up: the logo, the illustration, the tagline and the
 * agents CoForge works with. A brand panel, light in both themes, so its colours are fixed rather
 * than semantic tokens (which turn dark with the app).
 */
export function LoginBrandPanel() {
  return (
    <div className="login-brand-panel relative hidden flex-col bg-[#EEEBFE] px-10 pb-10 text-gray-600 lg:flex xl:px-20">
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
      <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm">
        {platforms.map((platform) => (
          <li key={platform.name} className="inline-flex items-center gap-2">
            <PlatformMark mark={platform.mark} monochrome={platform.monochrome} />
            {platform.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
