import type { ComponentPropsWithoutRef } from "react";

import { cn } from "#src/lib/utils";
import { ActorAvatar } from "./actor-avatar";

const OVERLAP = { tight: "-space-x-1", loose: "-space-x-1.5" } as const;

export const AVATAR_STACK_RING = {
  thin: "ring-[1.5px] ring-bg-primary",
  regular: "ring-2 ring-bg-primary",
} as const;

export function ActorAvatarStack({
  overlap = "loose",
  ring = "regular",
  more = 0,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"span"> & {
  overlap?: keyof typeof OVERLAP;
  ring?: keyof typeof AVATAR_STACK_RING;
  more?: number;
}) {
  return (
    <span {...props} className={cn("flex items-center", OVERLAP[overlap], className)}>
      {children}
      {more > 0 && (
        <ActorAvatar
          presence={false}
          size="xs"
          alt=""
          initials={`+${more}`}
          className={AVATAR_STACK_RING[ring]}
        />
      )}
    </span>
  );
}
