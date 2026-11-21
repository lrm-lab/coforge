import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

const CALM_DISABLED =
  "disabled:bg-secondary disabled:text-quaternary disabled:opacity-100 disabled:shadow-none disabled:ring-transparent disabled:before:hidden";

export function ComposerActions({
  canSave,
  canSend,
  saving,
  sending,
  preferDraft,
  onSaveDraft,
  onSend,
  className,
}: {
  canSave: boolean;
  canSend: boolean;
  saving: boolean;
  sending: boolean;
  preferDraft: boolean;
  onSaveDraft: () => void;
  onSend: () => void;
  className: string;
}) {
  return (
    <div className={cn("flex justify-end gap-1.5", className)}>
      <Button
        size="xs"
        color={preferDraft ? "primary" : "secondary"}
        className={CALM_DISABLED}
        type={preferDraft ? "submit" : "button"}
        isDisabled={!canSave}
        isLoading={saving}
        data-save-draft=""
        onClick={preferDraft ? undefined : onSaveDraft}
      >
        {m.av_cm_save_draft()}
      </Button>
      <Button
        size="xs"
        color={preferDraft ? "secondary" : "primary"}
        className={CALM_DISABLED}
        type={preferDraft ? "button" : "submit"}
        isDisabled={!canSend}
        isLoading={sending}
        data-send-comment=""
        onClick={preferDraft ? onSend : undefined}
      >
        {m.av_cm_send()}
      </Button>
    </div>
  );
}
