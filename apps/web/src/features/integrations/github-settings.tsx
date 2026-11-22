import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { InfoCircle } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { GitHubMark } from "#src/components/foundations/github-mark";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { m } from "#src/paraglide/messages";
import {
  disconnectGitHub,
  getGitHubConnection,
  refreshGitHubConnection,
  startGitHubConnection,
  startGitHubInstallation,
  startGitHubReauthorization,
} from "./github.functions";
import type { GitHubCallbackFailure } from "./github-callback";

const callbackFailureMessage = {
  error: m.github_callback_error,
  wrong_account: m.github_wrong_account,
  account_taken: m.github_account_taken,
} satisfies Record<GitHubCallbackFailure, () => string>;

export function GitHubSettings({ callbackFailure }: { callbackFailure?: GitHubCallbackFailure }) {
  const [connection, setConnection] = useState<Awaited<ReturnType<typeof getGitHubConnection>>>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = useServerFn(getGitHubConnection);
  const refresh = useServerFn(refreshGitHubConnection);
  const connect = useServerFn(startGitHubConnection);
  const install = useServerFn(startGitHubInstallation);
  const reauthorize = useServerFn(startGitHubReauthorization);
  const disconnect = useServerFn(disconnectGitHub);
  useEffect(() => {
    let cancelled = false;
    setConnection(undefined);
    setError(false);
    load()
      .then((value) => {
        if (cancelled) return;
        setConnection(value);
        refresh()
          .then((next) => {
            if (!cancelled) setConnection(next);
          })
          .catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [load, refresh, revision]);

  async function authorize() {
    setBusy(true);
    setError(false);
    try {
      window.location.assign((await connect()).url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function restoreAuthorization() {
    setBusy(true);
    setError(false);
    try {
      window.location.assign((await reauthorize()).url);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection() {
    setBusy(true);
    setError(false);
    try {
      await disconnect();
      setRevision((value) => value + 1);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function configureInstallation() {
    setBusy(true);
    setError(false);
    try {
      window.location.assign((await install()).url);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  async function retryRefresh() {
    setBusy(true);
    setError(false);
    try {
      setConnection(await refresh());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 px-page py-6 text-sm">
      <section
        aria-label="GitHub"
        className="flex flex-col gap-4 rounded-xl border border-secondary bg-primary p-4 sm:p-5 xl:flex-row xl:items-center xl:justify-between"
      >
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <GitHubMark className="size-7 text-fg-primary" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5">
              <h2 className="text-md font-semibold break-words text-primary">
                {connection?.login ? `@${connection.login} on GitHub` : "GitHub"}
              </h2>
              {connection?.status === "connected" && (
                <HoverPopover
                  label={m.github_repository_access()}
                  trigger={<InfoCircle className="size-4 text-fg-quaternary" />}
                  triggerClassName="shrink-0 rounded-full outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                  className="w-auto min-w-72"
                >
                  <div className="p-4">
                    <p className="font-semibold text-primary">{m.github_repository_access()}</p>
                    <ul className="mt-3 space-y-2 text-sm text-tertiary">
                      {connection.installations.map((installation) => (
                        <li key={installation.id} className="flex flex-wrap items-baseline gap-2">
                          <span className="font-medium text-secondary">@{installation.login}</span>
                          <span>
                            {installation.repositorySelection === "all"
                              ? m.github_all_repositories()
                              : m.github_selected_repositories()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </HoverPopover>
              )}
            </div>
            <p className="text-tertiary">
              {connection?.login ? m.github_disconnect_help() : m.github_description()}
            </p>
            {!connection && !error && (
              <p role="status" className="text-tertiary">
                {m.settings_loading()}
              </p>
            )}
            {connection?.status === "unconfigured" && (
              <p role="status" className="text-tertiary">
                {m.github_unconfigured()}
              </p>
            )}
            {connection?.status === "pending_installation" && (
              <p role="status" className="text-tertiary">
                {m.github_pending_installation()}
              </p>
            )}
            {connection?.status === "reauthorize" && (
              <p role="status" className="text-tertiary">
                {m.github_expired()}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {connection &&
            (connection.status === "disconnected" || connection.status === "reauthorize") && (
              <Button
                size="sm"
                color="primary"
                isDisabled={busy}
                onPress={connection.status === "reauthorize" ? restoreAuthorization : authorize}
              >
                {connection.status === "reauthorize" ? m.github_reauthorize() : m.github_connect()}
              </Button>
            )}
          {connection?.login && connection.installUrl && (
            <>
              <Button size="sm" color="secondary" isDisabled={busy} onPress={configureInstallation}>
                {m.github_configure()}
              </Button>
              <Button size="sm" color="secondary" isDisabled={busy} onPress={removeConnection}>
                {m.github_disconnect()}
              </Button>
            </>
          )}
          {error && (
            <Button size="sm" color="secondary" isDisabled={busy} onPress={retryRefresh}>
              {m.github_refresh()}
            </Button>
          )}
        </div>
      </section>
      {callbackFailure && (
        <p role="alert" className="text-error-primary">
          {callbackFailureMessage[callbackFailure]()}
        </p>
      )}
      {error && (
        <p role="alert" className="text-error-primary">
          {m.github_error()}
        </p>
      )}
    </div>
  );
}
