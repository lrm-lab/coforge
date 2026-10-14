import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { AuthSplitLayout } from "#src/features/auth/auth-split-layout";
import { checkWorkspaceSlug, submitDisplayName } from "#src/features/auth/first-sign-in.functions";
import { afterSignInHref } from "#src/features/auth/return-to";
import {
  checkPersonName,
  PERSON_NAME_MAX_LENGTH,
  type PersonNameProblem,
} from "#src/features/profiles/person-name";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
  nameToWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

type SlugProblem = "slug_invalid" | "slug_taken";
type Problem = PersonNameProblem | "save_failed" | SlugProblem;

const problemText: Record<Exclude<Problem, SlugProblem>, () => string> = {
  empty: () => m.welcome_error_empty(),
  too_long: () => m.welcome_error_too_long({ max: PERSON_NAME_MAX_LENGTH }),
  refused: () => m.welcome_error_refused(),
  save_failed: () => m.welcome_error_save_failed(),
};

const slugProblemText: Record<SlugProblem, () => string> = {
  slug_invalid: () => m.welcome_workspace_url_invalid(),
  slug_taken: () => m.welcome_workspace_url_taken(),
};

function isSlugProblem(problem: Problem): problem is SlugProblem {
  return problem === "slug_invalid" || problem === "slug_taken";
}

/** How long the URL must stand still before its availability is asked for. */
const SLUG_CHECK_DELAY_MS = 400;

/** The `/w/` a Workspace slug follows in every URL, in the URL field's leading icon slot. */
function SlugPrefix({ className }: { className?: string }) {
  return (
    <span className={cn(className, "flex items-center justify-center font-mono text-md")}>/w/</span>
  );
}

/**
 * Where a signed-in person who has not been asked for a display name lands once, before anything is
 * created for them. Continuing saves the name, makes their personal Workspace, titled with it, and
 * goes on to `returnTo` (or the app's own start page).
 */
export function NameStepPage({
  prefill,
  slugPrefill,
  returnTo,
}: {
  /** What the provider reported as the person's name, when it reads as one. */
  prefill: string;
  /** The URL the personal Workspace starts with: the username, unless it is only the fallback. */
  slugPrefill: string;
  returnTo: string | undefined;
}) {
  const submit = useServerFn(submitDisplayName);
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(prefill);
  const [workspaceSlug, setWorkspaceSlug] = useState(slugPrefill);
  // Until the person edits the URL, it follows the display name, unless the provider's name had
  // already given it a start.
  const [slugEdited, setSlugEdited] = useState(false);
  // The slug the server reported taken. Compared with the field's current value, so a report for
  // an earlier slug never shows against a later one.
  const [takenSlug, setTakenSlug] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set at once, where `submitting` only changes on the next render: a second Enter in between
  // must not start a second save.
  const inFlight = useRef(false);
  const slug = workspaceSlug.trim();

  useEffect(() => {
    if (!isValidWorkspaceSlug(slug) || isReservedWorkspaceSlug(slug)) return;
    let current = true;
    const timer = window.setTimeout(() => {
      // Errors are ignored: submitting asks the server again.
      checkWorkspaceSlug({ data: { slug } }).then(
        (result) => {
          if (current) setTakenSlug(result.available ? null : slug);
        },
        () => {},
      );
    }, SLUG_CHECK_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [slug]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    // The server judges the name and the URL again; asking here first only spares a round trip.
    const checked = checkPersonName(displayName);
    if (!checked.ok) return setProblem(checked.problem);
    if (!isValidWorkspaceSlug(slug) || isReservedWorkspaceSlug(slug)) {
      return setProblem("slug_invalid");
    }
    setProblem(null);
    inFlight.current = true;
    setSubmitting(true);
    const stop = (next: Problem) => {
      setProblem(next);
      setSubmitting(false);
      inFlight.current = false;
    };
    let result: Awaited<ReturnType<typeof submit>> | undefined;
    try {
      result = await submit({ data: { displayName, workspaceSlug: slug } });
    } catch {
      return stop("save_failed");
    }
    // `useServerFn` resolves with nothing when the call redirected (the session is gone): the
    // router is already taking the person to sign in.
    if (!result) return;
    if (!result.ok) return stop(result.problem);
    // The name is saved, so a failure from here on is not a failed save. Stay busy through the
    // navigation: the page is replaced, not returned to.
    const destination = afterSignInHref(returnTo);
    try {
      await navigate({ href: destination });
    } catch {
      window.location.assign(destination);
    }
  }

  // A problem from submitting belongs to the field it names; the name's problems stay under the
  // name, and `save_failed` is not about either field.
  const nameProblem = problem !== null && !isSlugProblem(problem) ? problem : null;
  const slugMessage: SlugProblem | null =
    problem !== null && isSlugProblem(problem) ? problem : takenSlug === slug ? "slug_taken" : null;

  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src="/logo.svg" alt="" className="size-12" />
          <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
            {m.welcome_title()}
          </h1>
        </div>
        <form noValidate onSubmit={onSubmit}>
          <div className="flex flex-col gap-6">
            <Input
              label={m.welcome_display_name_label()}
              name="displayName"
              autoComplete="nickname"
              autoFocus
              value={displayName}
              onChange={(value) => {
                setDisplayName(value);
                if (!slugEdited && slugPrefill === "") setWorkspaceSlug(nameToWorkspaceSlug(value));
                setProblem(null);
              }}
              isInvalid={nameProblem !== null}
              hint={
                nameProblem ? <span role="alert">{problemText[nameProblem]()}</span> : undefined
              }
            />
            <Input
              label={m.welcome_workspace_url_label()}
              name="workspaceSlug"
              autoComplete="off"
              value={workspaceSlug}
              icon={SlugPrefix}
              inputClassName="font-mono"
              onChange={(value) => {
                setWorkspaceSlug(value);
                setSlugEdited(true);
                setProblem(null);
              }}
              isInvalid={slugMessage !== null}
              hint={
                slugMessage ? <span role="alert">{slugProblemText[slugMessage]()}</span> : undefined
              }
            />
          </div>
          <Button
            type="submit"
            size="lg"
            className="mt-6 w-full"
            isLoading={submitting}
            showTextWhileLoading
          >
            {m.welcome_continue()}
          </Button>
        </form>
      </div>
    </AuthSplitLayout>
  );
}
