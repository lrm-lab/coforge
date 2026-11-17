import { AtSign } from "@untitledui/icons";

export function MentionBadge() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-unread-capsule-muted text-primary"
    >
      <AtSign aria-hidden="true" className="size-3 [stroke-width:2.25]" />
    </span>
  );
}
