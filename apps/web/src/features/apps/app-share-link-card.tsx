import { useEffect, useState } from "react";
import { useHydrated } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { isAppErrorCode } from "#src/lib/app-error";
import { formatDateForDisplay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import {
  createAppShareLink,
  loadAppShareLink,
  revokeAppShareLink,
  type AppShareLinkStatus,
} from "./app-share-links.functions";
import { SecretValueAlert } from "./app-secret-panel";

/** The create button's text: Create link, or Regenerate when a link is active, while it runs too. */
function createLabel(hasLink: boolean, busy: boolean): string {
  if (hasLink) return busy ? m.apps_share_regenerating() : m.apps_share_regenerate();
  return busy ? m.apps_share_creating() : m.apps_share_create();
}

type Running = "create" | "revoke" | null;

/**
 * The editor's "Private share link" card (inside Distribution, behind `app-marketplace`): whether
 * a link is active and when it ends, Create or Regenerate (which revokes the old link), and Revoke.
 * The URL is shown once, when it is made, and never again, because the server keeps only its hash.
 * A private or rejected app can get a link; once it is requested or published only an existing
 * link is shown, so it can still be revoked. Each action acts at once, apart from the form's Save.
 */
export function ShareLinkCard({ appKey, canShare }: { appKey: string; canShare: boolean }) {
  const hydrated = useHydrated();
  const [status, setStatus] = useState<AppShareLinkStatus | undefined>(undefined);
  const [url, setUrl] = useState<string | null>(null);
  const [running, setRunning] = useState<Running>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    setStatus(undefined);
    setUrl(null);
    loadAppShareLink({ data: { key: appKey } }).then(
      (loaded) => current && setStatus(loaded),
      () => current && setError(m.apps_share_error_load()),
    );
    return () => {
      current = false;
    };
  }, [appKey]);

  async function run(which: Exclude<Running, null>) {
    setRunning(which);
    setError("");
    try {
      if (which === "create") {
        const link = await createAppShareLink({ data: { key: appKey } });
        setUrl(`${window.location.origin}${link.path}`);
        setStatus({ createdAt: link.createdAt, expiresAt: link.expiresAt });
      } else {
        await revokeAppShareLink({ data: { key: appKey } });
        setUrl(null);
        setStatus(null);
      }
    } catch (cause) {
      setError(
        which === "create" && isAppErrorCode(cause, "CONFLICT")
          ? m.apps_share_error_status()
          : which === "create"
            ? m.apps_share_error_create()
            : m.apps_share_error_revoke(),
      );
    } finally {
      setRunning(null);
    }
  }

  // Nothing to offer: no link, and the app's status does not allow one.
  if (status === null && !canShare) return null;
  const busy = running !== null;
  return (
    <div className="grid gap-3 rounded-xl border border-secondary p-4">
      <div className="grid min-w-0 gap-1">
        <p className="text-sm font-medium text-primary">{m.apps_share_title()}</p>
        <p className="text-sm text-tertiary">{m.apps_share_description()}</p>
      </div>
      {error && <Alert color="error" title={error} />}
      {url && (
        <SecretValueAlert
          title={m.apps_share_created_title()}
          notice={m.apps_share_once()}
          value={url}
          copyLabel={m.apps_share_copy()}
        />
      )}
      {!url && status && (
        <p className="text-sm text-tertiary">
          {m.apps_share_active({
            when: hydrated ? formatDateForDisplay(status.expiresAt, null, getLocale()) : "",
          })}
        </p>
      )}
      {status === null && <p className="text-sm text-tertiary">{m.apps_share_none()}</p>}
      {status !== undefined && (
        <div className="flex flex-wrap gap-2">
          {canShare && (
            <Button
              type="button"
              size="sm"
              color={status ? "secondary" : "primary"}
              isDisabled={busy}
              isLoading={running === "create"}
              showTextWhileLoading
              onPress={() => void run("create")}
            >
              {createLabel(status !== null, running === "create")}
            </Button>
          )}
          {status && (
            <Button
              type="button"
              size="sm"
              color="secondary-destructive"
              isDisabled={busy}
              isLoading={running === "revoke"}
              showTextWhileLoading
              onPress={() => void run("revoke")}
            >
              {running === "revoke" ? m.apps_share_revoking() : m.apps_share_revoke()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
