import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useCommentDraftActions } from "./artifact-comment-drafts-context";

export function DraftsLoadFailed({ className }: { className?: string }) {
  const { reload } = useCommentDraftActions();
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <p role="alert" className="text-sm text-error-primary">
        {m.av_dr_load_failed()}
      </p>
      <Button size="sm" color="secondary" onClick={reload}>
        {m.av_cm_retry()}
      </Button>
    </div>
  );
}
