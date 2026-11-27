import * as React from "react";
import { FIELD_STATES } from "#src/components/base/input/field-states";
import { cn } from "#src/lib/utils";
import { OTPInput, OTPInputContext } from "input-otp";

const InputOTPInvalidContext = React.createContext(false);

function isAriaInvalid(value: React.AriaAttributes["aria-invalid"]) {
  return value === true || value === "true" || value === "grammar" || value === "spelling";
}

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) {
  return (
    <InputOTPInvalidContext.Provider value={isAriaInvalid(props["aria-invalid"])}>
      <OTPInput
        data-slot="input-otp"
        containerClassName={cn(
          "cn-input-otp flex items-center has-disabled:opacity-50",
          containerClassName,
        )}
        spellCheck={false}
        className={cn("disabled:cursor-not-allowed", className)}
        {...props}
      />
    </InputOTPInvalidContext.Provider>
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

function InputOTPSlot({
  index,
  className,
  isInvalid: invalidProp,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
  isInvalid?: boolean;
}) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const groupInvalid = React.useContext(InputOTPInvalidContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};
  const isInvalid = invalidProp ?? groupInvalid;

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      data-invalid={isInvalid || undefined}
      className={cn(
        "relative flex size-9 items-center justify-center text-sm font-medium tabular-nums text-field-text data-invalid:text-error-primary",
        FIELD_STATES.box,
        isActive && !isInvalid && "z-10 ring-1 ring-focus-ring outline-2 outline-focus-ring/20",
        isInvalid &&
          (isActive
            ? "z-10 ring-1 ring-field-border-error outline-2 outline-focus-ring-error/25"
            : FIELD_STATES.invalid),
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-caret-blink bg-focus-ring duration-1000 motion-reduce:animate-none" />
        </div>
      )}
    </div>
  );
}

function InputOTPSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      className={cn("text-center text-xl font-medium text-tertiary", className)}
      role="separator"
      {...props}
    >
      -
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
