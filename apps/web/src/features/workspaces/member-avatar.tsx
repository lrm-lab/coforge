import type { AvatarProps } from "#src/components/base/avatar/avatar";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { useMemberOnline } from "./member-presence";

/** A Workspace member's avatar with their online dot, wherever a member is shown by face. A
 * member with no picture shows the cartoon person their id chooses. */
export function MemberAvatar({
  userId,
  name,
  src,
  size,
  className,
}: {
  userId: string;
  name: string;
  src: string | null;
  size: AvatarProps["size"];
  className?: string;
}) {
  const online = useMemberOnline(userId);
  return (
    <IdentityAvatar
      size={size}
      className={className}
      name={name}
      userId={userId}
      alt={name}
      src={src}
      // No dot until presence is known: an unknown state is never drawn as offline.
      status={online === undefined ? undefined : online ? "online" : "offline"}
    />
  );
}
