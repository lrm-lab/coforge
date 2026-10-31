import type { ReactNode } from "react";
import { XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";

export function OutlineRow({
  label,
  value,
  onChange,
  onRemove,
  removeLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-sm text-tertiary">{label}</span>
      <Input className="min-w-0 flex-1" value={value} onChange={onChange} />
      <ButtonUtility
        size="sm"
        color="tertiary"
        icon={X}
        aria-label={removeLabel}
        onClick={onRemove}
      />
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-secondary">{label}</span>
      {children}
    </div>
  );
}
