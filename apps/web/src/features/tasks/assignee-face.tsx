import type { FC } from "react";

import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { cx } from "#src/utils/cx";

const faces = new Map<string, FC<{ className?: string }>>();

/**
 * A `Dropdown.Item` icon drawing an assignee's face, so an Agent's mascot is its sticker: the
 * dropdown's own `avatarUrl` draws a photo tile, which would clip it. One component per picture,
 * kept, so a menu re-render does not remount the face.
 */
export function assigneeFace(src: string): FC<{ className?: string }> {
  let face = faces.get(src);
  if (!face) {
    face = ({ className }) => (
      <span className={cx(className, "flex items-center justify-center")}>
        <IdentityAvatar size="xs" src={src} alt="" className="size-5" />
      </span>
    );
    faces.set(src, face);
  }
  return face;
}
