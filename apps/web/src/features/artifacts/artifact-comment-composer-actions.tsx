import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

const CALM_DISABLED =
  "disabled:bg-tertiary disabled:text-quaternary disabled:opacity-100 disabled:shadow-none disabled:ring-transparent disabled:before:hidden";

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
  const emphasis = (primary: boolean) =>
    primary
      ? ({ color: "primary", className: CALM_DISABLED } as const)
      : ({ color: "tertiary" } as const);
  return (
    <div className={cn("flex justify-end gap-1", className)}>
      <Button
        size="xs"
        {...emphasis(hasDrafts)}
        isDisabled={!canSave}
        isLoading={saving}
        data-save-draft=""
        onPress={onSave}
      >
        {m.av_dr_save()}
      </Button>
      <Button
        size="xs"
        {...emphasis(!hasDrafts)}
        type="submit"
        isDisabled={!canSend}
        isLoading={sending}
      >
        {m.av_dr_send()}
      </Button>
    </div>
  );
}
