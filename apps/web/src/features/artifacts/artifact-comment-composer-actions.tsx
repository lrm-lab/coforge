import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

const CALM_DISABLED =
  "disabled:bg-tertiary disabled:text-quaternary disabled:opacity-100 disabled:shadow-none disabled:ring-transparent disabled:before:hidden";

export function ComposerActions({
  canSave,
  saving,
  className,
}: {
  canSave: boolean;
  saving: boolean;
  className: string;
}) {
  return (
    <div className={cn("flex justify-end gap-1", className)}>
      <Button
        size="xs"
        color="primary"
        className={CALM_DISABLED}
        type="submit"
        isDisabled={!canSave}
        isLoading={saving}
        data-save-draft=""
      >
        {m.av_dr_add()}
      </Button>
    </div>
  );
}
