import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { cn } from "#src/lib/utils";
import {
  RUNTIME_PROVIDER_MARK,
  RUNTIME_PROVIDER_MARK_IS_COLOR_ICON,
} from "./runtime-provider-display";

/**
 * A provider's mark at any size: CoForge's own as an inline SVG, full-colour marks as an `<img>`, monochrome glyphs as a
 * CSS mask so they follow the current text colour. Shared by the runtime picker, the Agent
 * profile panel's Runtime badge and the Computer page's runtime rows.
 */
export function RuntimeProviderMark({
  provider,
  className = "size-4",
  glyphColor = "bg-fg-primary",
}: {
  provider: RuntimeProvider;
  className?: string;
  /** A single-colour glyph's fill; a surface that keeps its colours in both themes (the sign-in
   * page's brand panel) passes a fixed one. Full-colour marks ignore it. */
  glyphColor?: string;
}) {
  if (provider === RUNTIME_PROVIDER.COFORGE) return <CoForgeMark className={className} />;
  const mark = RUNTIME_PROVIDER_MARK[provider];
  if (RUNTIME_PROVIDER_MARK_IS_COLOR_ICON[provider])
    return <img src={mark} alt="" className={cn("shrink-0", className)} />;
  return (
    <span
      aria-hidden="true"
      className={cn("shrink-0 mask-contain mask-center mask-no-repeat", glyphColor, className)}
      style={{ maskImage: `url("${mark}")`, WebkitMaskImage: `url("${mark}")` }}
    />
  );
}
