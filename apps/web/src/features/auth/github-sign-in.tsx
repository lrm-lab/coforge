import githubMark from "@lobehub/icons-static-svg/icons/github.svg";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { githubSignInHref, type SignInError } from "./return-to";

const errorText: Record<SignInError, () => string> = {
  github_denied: () => m.login_github_denied(),
  github_failed: () => m.login_github_failed(),
  rate_limited: () => m.login_rate_limited(),
};

/** The logo in the button's text colour, as the icon the button styles. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "size-5 shrink-0 bg-current mask-contain mask-center mask-no-repeat",
        className,
      )}
      // Vite inlines small SVGs as data URLs that contain quotes, so the url() must be quoted.
      style={{ maskImage: `url("${githubMark}")`, WebkitMaskImage: `url("${githubMark}")` }}
    />
  );
}

/**
 * Signing in with GitHub, below the sign-in forms: a document navigation to `/auth/github`, which
 * takes the person to GitHub and back through the server (`server/auth/github-sign-in`). A
 * sign-in that came back without completing says why (`error`) above the button.
 */
export function GitHubSignIn({
  returnTo,
  prompt,
  error,
}: {
  returnTo?: string | undefined;
  /** `"login"` when the page was asked to sign the person in afresh: the way back keeps asking. */
  prompt?: "login" | undefined;
  error?: SignInError | undefined;
}) {
  return (
    <div className="flex flex-col gap-6">
      <hr className="border-secondary" />
      {error ? (
        <HintText isInvalid role="alert" className="text-md">
          {errorText[error]()}
        </HintText>
      ) : null}
      <Button
        color="secondary"
        size="lg"
        className="w-full"
        iconLeading={GitHubMark}
        onPress={() => window.location.assign(githubSignInHref(returnTo, prompt))}
      >
        {m.login_github()}
      </Button>
    </div>
  );
}
