import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export function ComposerActions({
  hasDrafts,
  canSend,
  canSave,
  sending,
  saving,
  onSave,
  className,
}: {
  hasDrafts: boolean;
  canSend: boolean;
  canSave: boolean;
  sending: boolean;
  saving: boolean;
  onSave: () => void;
  className: string;
}) {
  return (
    <div className={cn("flex justify-end gap-2", className)}>
      <Button
        size="sm"
        color={hasDrafts ? "primary" : "secondary"}
        isDisabled={!canSave}
        isLoading={saving}
        data-save-draft=""
        onPress={onSave}
      >
        {m.av_dr_save()}
      </Button>
      <Button
        size="sm"
        color={hasDrafts ? "secondary" : "primary"}
        type="submit"
        isDisabled={!canSend}
        isLoading={sending}
      >
        {m.av_dr_send()}
      </Button>
    </div>
  );
}
