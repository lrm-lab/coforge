import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  BarChart07,
  Check,
  Code02,
  PenTool01,
  Rocket02,
  SearchLg,
  Target04,
} from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { DialogAction, DialogCancel } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";
import { WizardShell } from "./onboarding-wizard-frame";
import { PERSON_ROLES, type PersonRole } from "./person-role";

type RoleIcon = ComponentType<SVGProps<SVGSVGElement> & { color?: string; size?: number }>;

const ROLES: Record<PersonRole, { icon: RoleIcon; label: () => string }> = {
  engineer: { icon: Code02, label: () => m.onboarding_wizard_role_engineer() },
  designer: { icon: PenTool01, label: () => m.onboarding_wizard_role_designer() },
  product: { icon: Target04, label: () => m.onboarding_wizard_role_product() },
  marketing: { icon: BarChart07, label: () => m.onboarding_wizard_role_marketing() },
  research: { icon: SearchLg, label: () => m.onboarding_wizard_role_research() },
  founder: { icon: Rocket02, label: () => m.onboarding_wizard_role_founder() },
};

/** One role as a card: the same look as the computer cards, with no description under the name. */
function RoleOption({
  icon: Icon,
  label,
  selected,
  onSelect,
}: {
  icon: RoleIcon;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      color="secondary"
      aria-pressed={selected}
      className={`relative h-auto flex-col items-stretch justify-start whitespace-normal rounded-xl p-4 text-left shadow-xs ${selected ? "border-brand bg-primary ring-1 ring-brand" : "hover:bg-primary_hover"}`}
      onPress={onSelect}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-lg border border-secondary bg-primary text-tertiary shadow-xs">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <span
        aria-hidden="true"
        className={`absolute top-4 right-4 flex size-5 items-center justify-center rounded-full border border-secondary ${selected ? "border-brand bg-brand-solid text-white" : "bg-primary"}`}
      >
        {selected && <Check className="size-3.5" />}
      </span>
      <span className="block text-sm font-semibold">{label}</span>
    </Button>
  );
}

/** Step 3: what the member mainly does, as selectable cards. Optional; the assistant reads the
 * answer, nobody sees it. */
export function OnboardingRoleStep({
  role,
  onRole,
  onNext,
  skip,
}: {
  role: PersonRole | undefined;
  onRole: (role: PersonRole) => void;
  /** Goes on with the picked role, or with none (`undefined`) when this step is skipped. */
  onNext: (role: PersonRole | undefined) => void;
  /** The quiet "skip setup" on the footer's left. */
  skip: ReactNode;
}) {
  return (
    <WizardShell
      step="role"
      title={m.onboarding_wizard_role_title()}
      description={m.onboarding_wizard_role_description()}
      skip={skip}
      actions={
        <>
          <DialogCancel onPress={() => onNext(undefined)}>
            {m.onboarding_wizard_role_skip()}
          </DialogCancel>
          <DialogAction isDisabled={role === undefined} onPress={() => onNext(role)}>
            {m.controls_next()}
          </DialogAction>
        </>
      }
    >
      <div
        role="group"
        aria-label={m.onboarding_wizard_role_title()}
        className="grid gap-3 px-6 py-6 grid-cols-2 sm:grid-cols-3 sm:px-8"
      >
        {PERSON_ROLES.map((value) => (
          <RoleOption
            key={value}
            icon={ROLES[value].icon}
            label={ROLES[value].label()}
            selected={role === value}
            onSelect={() => onRole(value)}
          />
        ))}
      </div>
    </WizardShell>
  );
}
