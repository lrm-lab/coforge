import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { m } from "#src/paraglide/messages";
import { AuthSplitLayout } from "./auth-split-layout";
import { PasswordResetForm } from "./password-reset-form";

/** Setting a new password with a code (`/login/reset-password`), for an account that forgot its
 * password or signed up with a code and never had one. */
export function PasswordResetPage({
  returnTo,
  prompt,
}: {
  returnTo?: string | undefined;
  prompt?: "login" | undefined;
}) {
  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <CoForgeMark className="h-10" />
          <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
            {m.login_reset_title()}
          </h1>
        </div>
        <PasswordResetForm returnTo={returnTo} prompt={prompt} />
      </div>
    </AuthSplitLayout>
  );
}
