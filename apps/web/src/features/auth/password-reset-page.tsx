import { Link } from "@tanstack/react-router";

import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { m } from "#src/paraglide/messages";
import { PasswordResetForm } from "./password-reset-form";
import "./login-art.css";

/**
 * Setting a new password with a code (`/login/reset-password`), for an account that forgot its
 * password or signed up with a code and never had one. jing's design (11-12): from `xl` up, the
 * sign-in page's lavender and its logo, in the same place, over one wide card with the form in its
 * middle, no illustration; below `xl`, the form under the logo, as on the sign-in page.
 */
export function PasswordResetPage({
  returnTo,
  prompt,
}: {
  returnTo?: string | undefined;
  prompt?: "login" | undefined;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col bg-primary px-4 py-8 safe-area-padding md:px-8 xl:bg-[#EEEBFE] xl:px-16 xl:pt-[6.5rem] xl:pb-16">
      {/* Placed by `login-art.css` where the sign-in page and the homepage put theirs. */}
      <Link to="/" aria-label="CoForge" className="login-brand-logo max-xl:hidden">
        <img src="/login/homepage-logo.webp" alt="" className="h-auto w-full" />
      </Link>
      <Link to="/" aria-label="CoForge" className="self-start xl:hidden">
        <CoForgeMark className="h-7" />
      </Link>
      {/* From the top, not centred, so a problem said under the fields never moves the tabs. */}
      <main className="flex flex-1 items-start justify-center pt-12 xl:mx-auto xl:w-full xl:max-w-[67.5rem] xl:rounded-[1.875rem] xl:bg-primary xl:pt-[max(3rem,calc(50dvh-19.25rem))] xl:pb-12">
        <div className="login-form w-full max-w-sm xl:w-[22.5rem]">
          <h1 className="sr-only">{m.login_reset_title()}</h1>
          <PasswordResetForm returnTo={returnTo} prompt={prompt} />
        </div>
      </main>
    </div>
  );
}
