import { useImageFallback } from "#src/hooks/use-image-fallback";
import { avatarInitial } from "#src/lib/avatar-tone";
import { cx } from "#src/utils/cx";

export function workspaceInitial(name: string): string {
  return name.trim() ? avatarInitial(name) : "W";
}

export function WorkspaceIcon({
  name,
  url,
  className,
}: {
  name: string;
  url: string | null;
  className?: string;
}) {
  const image = useImageFallback(url);

  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary font-semibold text-tertiary",
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
        workspaceInitial(name)
      )}
    </span>
  );
}
