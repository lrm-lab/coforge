import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { InfoCircle } from "@untitledui/icons";
import { Popover as AriaPopover } from "react-aria-components";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { GitHubMark } from "#src/components/foundations/github-mark";
import { Dialog, DialogTrigger } from "#src/components/ui/modal";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";
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
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const load = useServerFn(getGitHubConnection);
  const refresh = useServerFn(refreshGitHubConnection);
  const connect = useServerFn(startGitHubConnection);
  const install = useServerFn(startGitHubInstallation);
  const reauthorize = useServerFn(startGitHubReauthorization);
  const disconnect = useServerFn(disconnectGitHub);
  const connectionQuery = useQuery({
    queryKey: ["github", "connection"],
    queryFn: () => load(),
    retry: false,
  });
  const connection = connectionQuery.data;
  const error = actionError || connectionQuery.isError;

  useEffect(() => {
    if (!connectionQuery.isSuccess) return;
    let active = true;
    refresh()
      .then((next) => {
        if (active) queryClient.setQueryData(["github", "connection"], next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connectionQuery.isSuccess, queryClient, refresh]);

  async function authorize() {
    setBusy(true);
    setActionError(false);
    try {
      window.location.assign((await connect()).url);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }

  async function restoreAuthorization() {
    setBusy(true);
    setActionError(false);
    try {
      window.location.assign((await reauthorize()).url);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }

  async function configureInstallation() {
    setBusy(true);
    setActionError(false);
    try {
      window.location.assign((await install()).url);
    } catch {
      setActionError(true);
      setBusy(false);
    }
  }

  async function retryRefresh() {
    setBusy(true);
    setActionError(false);
    try {
      queryClient.setQueryData(["github", "connection"], await refresh());
    } catch {
      setActionError(true);
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
                <DialogTrigger>
                  <ButtonUtility
                    icon={InfoCircle}
                    size="xs"
                    color="tertiary"
                    aria-label={m.github_repository_access()}
                  />
                  <AriaPopover
                    placement="bottom start"
                    offset={6}
                    className={`w-auto min-w-72 max-w-[calc(100vw-1rem)] origin-(--trigger-anchor-point) rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-none will-change-transform ${POPOVER_MOTION}`}
                  >
                    <Dialog aria-label={m.github_repository_access()} className="p-4 outline-none">
                      <p className="font-semibold text-primary">{m.github_repository_access()}</p>
                      <ul className="mt-3 space-y-2 text-sm text-tertiary">
                        {connection.installations.map((installation) => (
                          <li key={installation.id} className="flex flex-wrap items-baseline gap-2">
                            <span className="font-medium text-secondary">
                              @{installation.login}
                            </span>
                            <span>
                              {installation.repositorySelection === "all"
                                ? m.github_all_repositories()
                                : m.github_selected_repositories()}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Dialog>
                  </AriaPopover>
                </DialogTrigger>
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
              <Popconfirm
                title={m.github_disconnect()}
                description={m.github_disconnect_help()}
                confirmLabel={m.github_disconnect()}
                errorMessage={m.github_error()}
                placement="bottom end"
                isDisabled={busy}
                onConfirm={async () => {
                  await disconnect();
                  await queryClient.invalidateQueries({ queryKey: ["github"] });
                }}
              >
                <Button size="sm" color="secondary" isDisabled={busy}>
                  {m.github_disconnect()}
                </Button>
              </Popconfirm>
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
