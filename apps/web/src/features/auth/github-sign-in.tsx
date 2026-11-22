import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { GitHubMark } from "#src/components/foundations/github-mark";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { githubSignInHref, type SignInError } from "./return-to";

const errorText: Record<SignInError, () => string> = {
  github_denied: () => m.login_github_denied(),
  github_failed: () => m.login_github_failed(),
};

/** The mark stays the text colour of the page while the label is muted. */
const DarkMark = ({ className }: { className?: string }) => (
  <GitHubMark className={cx(className, "text-primary")} />
);

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
    <div className="flex flex-col gap-4">
      {error ? (
        <HintText isInvalid role="alert" className="text-md">
          {errorText[error]()}
        </HintText>
      ) : null}
      <Button
        color="secondary"
        size="lg"
        className="login-outline w-full text-sm"
        iconLeading={DarkMark}
        onPress={() => window.location.assign(githubSignInHref(returnTo, prompt))}
      >
        {m.login_github()}
      </Button>
    </div>
  );
}
