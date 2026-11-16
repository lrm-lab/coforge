import { ActorAvatar } from "#src/features/avatars/actor-avatar";

type Size = "xs" | "sm";

export function CommentAuthorAvatar({
  comment,
  size,
}: {
  comment: { author: { name: string; kind: string }; authorId: string | null };
  size: Size;
}) {
  const { author, authorId } = comment;
  return (
    <ActorAvatar
      presence={false}
      size={size}
      name={author.name}
      {...(author.kind === "agent"
        ? { agentId: authorId ?? undefined }
        : { userId: authorId ?? undefined })}
    />
  );
}
