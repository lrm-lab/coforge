import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import githubMark from "@lobehub/icons-static-svg/icons/github.svg";

import { Button } from "#src/components/base/buttons/button";
import { AuthSplitLayout } from "#src/features/auth/auth-split-layout";
import { localizedReturnHref } from "#src/features/auth/return-to";
import { m } from "#src/paraglide/messages";
import type { GitHubStepAction } from "./github-step";
import { useStartGitHubFlow } from "./use-start-github-flow";

const actionLabel: Record<GitHubStepAction, () => string> = {
  connect: () => m.onboarding_github_step_connect(),
  install: () => m.onboarding_github_step_install(),
  reauthorize: () => m.onboarding_github_step_reauthorize(),
};

/**
 * The full-page "Connect GitHub" step after a Workspace is created. The main button starts the
 * flow the connection's status calls for and comes back to the Workspace home; skipping stores
 * nothing (the setup checklist keeps reminding) and goes on to `next`.
 */
export function GitHubStepPage({ action, next }: { action: GitHubStepAction; next: string }) {
  const navigate = useNavigate();
  const startFlow = useStartGitHubFlow();
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function start() {
    setFailed(false);
    setStarting(true);
    try {
      // Stay busy on success: the page is replaced by GitHub's.
      await startFlow(action);
    } catch {
      setFailed(true);
      setStarting(false);
    }
  }

  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src={githubMark} alt="" className="size-12 dark:invert" />
          <div className="flex flex-col gap-2 md:gap-3">
            <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
              {m.onboarding_github_step_title()}
            </h1>
            <p className="text-md text-tertiary">{m.onboarding_github_step_description()}</p>
          </div>
        </div>
        <div className="flex flex-col items-center gap-3">
          {failed && (
            <p role="alert" className="text-center text-sm text-error-primary">
              {m.onboarding_github_step_error()}
            </p>
          )}
          <Button size="lg" className="w-full" isLoading={starting} onPress={() => void start()}>
            {actionLabel[action]()}
          </Button>
          <Button
            size="lg"
            color="link-gray"
            isDisabled={starting}
            onPress={() => void navigate({ href: localizedReturnHref(next) })}
          >
            {m.onboarding_github_step_skip()}
          </Button>
        </div>
      </div>
    </AuthSplitLayout>
  );
}
