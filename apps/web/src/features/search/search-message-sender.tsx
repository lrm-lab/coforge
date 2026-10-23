import { IdentityAvatar } from "#src/features/avatars/identity-avatar";

/** Who sent a found message: their 16px face, a person's photo or an Agent's mascot sticker, and
 * their name. */
export function SearchMessageSender({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl: string | null;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <IdentityAvatar size="xs" src={avatarUrl} name={name} alt="" className="size-4 shrink-0" />
      <span className="truncate font-semibold text-secondary">{name}</span>
    </span>
  );
}
