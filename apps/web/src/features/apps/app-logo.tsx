import { useState } from "react";

import { cn } from "#src/lib/utils";
import { appMonogram } from "./app-list";

const SIZES = {
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-16 text-xl",
} as const;

/** An app's logo: its uploaded image when it has one (`url`), otherwise, or when the image does not
 * load, the monogram made from its name, on a neutral tile. */
export function AppLogo({
  name,
  url = null,
  size = "md",
}: {
  name: string;
  url?: string | null;
  size?: keyof typeof SIZES;
}) {
  // The URL that failed to load, so a new one is tried again.
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-tertiary font-semibold text-secondary ring-1 ring-secondary ring-inset",
        SIZES[size],
      )}
    >
      {url !== null && url !== failed ? (
        <img src={url} alt="" className="size-full object-cover" onError={() => setFailed(url)} />
      ) : (
        appMonogram(name)
      )}
    </span>
  );
}
