import { ActorAvatar } from "#src/features/avatars/actor-avatar";

type Size = "xs" | "sm";

export function CommentAuthorAvatar({
  comment,
  size,
}: {
  comment: {
    author: { name: string; kind: string };
    authorId: string | null;
    authorAvatarUrl: string | null;
  };
  size: Size;
}) {
  const { author, authorId, authorAvatarUrl } = comment;
  return (
    <ActorAvatar
      presence={false}
      size={size}
      src={authorAvatarUrl ?? undefined}
      name={author.name}
      {...(author.kind === "agent"
        ? { agentId: authorId ?? undefined }
        : { userId: authorId ?? undefined })}
    />
  );
}
