import type { ReactNode } from "react";

import { useImageFallback } from "#src/hooks/use-image-fallback";
import { avatarInitial } from "#src/lib/avatar-tone";
import { cx } from "#src/utils/cx";

export function ProjectImage({
  name,
  url,
  fallback,
  className,
}: {
  name: string;
  url: string | null;
  fallback?: ReactNode;
  className?: string;
}) {
  const image = useImageFallback(url);

  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary font-medium text-tertiary",
        className,
      )}
    >
      {image.src ? (
        <img
          ref={image.ref}
          src={image.src}
          alt=""
          onError={image.onError}
          className="size-full object-cover"
        />
      ) : (
        (fallback ?? avatarInitial(name))
      )}
    </span>
  );
}
