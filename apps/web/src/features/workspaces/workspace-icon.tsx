import { avatarInitial } from "#src/lib/avatar-tone";
import { cx } from "#src/utils/cx";

/** What a Workspace without an icon shows: the first letter of its name, as an avatar finds it. */
export function workspaceInitial(name: string): string {
  return name.trim() ? avatarInitial(name) : "W";
}

/** The Workspace's uploaded icon, or the first letter of its name on a plain tile. */
export function WorkspaceIcon({
  name,
  url,
  className,
}: {
  name: string;
  url: string | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary font-semibold text-tertiary",
        className,
      )}
    >
      {url ? <img src={url} alt="" className="size-full object-cover" /> : workspaceInitial(name)}
    </span>
  );
}
