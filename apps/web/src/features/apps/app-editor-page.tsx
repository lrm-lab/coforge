import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { isAppErrorCode } from "#src/lib/app-error";
import { AppEditor } from "./app-editor";
import { isPermissionsChanged, type AppEditorSubmission } from "./app-form";
import type { IssuedSecret } from "./app-secret-panel";
import { useAppPublishing } from "./use-app-publishing";
import { useRefreshOnFocus } from "./use-refresh-on-focus";
import {
  approveWorkspaceAppPermissions,
  deleteWorkspaceApp,
  loadWorkspaceApps,
  registerWorkspaceApp,
  resetWorkspaceAppLogo,
  rotateWorkspaceAppSecret,
  updateWorkspaceApp,
  uploadWorkspaceAppLogo,
  type AppDeclarations,
  type AppSummary,
} from "./apps.functions";

let stashedIssuedSecret: (IssuedSecret & { key: string }) | null = null;

function stashIssuedAppSecret(secret: IssuedSecret & { key: string }) {
  stashedIssuedSecret = secret;
}

function takeIssuedAppSecret(key: string | undefined): (IssuedSecret & { key: string }) | null {
  if (!key || stashedIssuedSecret?.key !== key) return null;
  const held = stashedIssuedSecret;
  stashedIssuedSecret = null;
  return held;
}

export function AppEditorPage({
  appKey,
  initialApps,
  initialDeclares,
}: {
  appKey?: string;
  initialApps: AppSummary[];
  initialDeclares: AppDeclarations;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppSummary[] | undefined>(initialApps);
  const [declares, setDeclares] = useState<AppDeclarations>(initialDeclares);
  const [issued, setIssued] = useState<(IssuedSecret & { key: string }) | null>(() =>
    takeIssuedAppSecret(appKey),
  );
  const load = useServerFn(loadWorkspaceApps);
  const register = useServerFn(registerWorkspaceApp);
  const update = useServerFn(updateWorkspaceApp);
  const rotate = useServerFn(rotateWorkspaceAppSecret);
  const remove = useServerFn(deleteWorkspaceApp);
  const resetLogo = useServerFn(resetWorkspaceAppLogo);
  const uploadLogo = useServerFn(uploadWorkspaceAppLogo);
  const approve = useServerFn(approveWorkspaceAppPermissions);

  const read = useCallback(async () => {
    const loaded = await load();
    setApps(loaded.apps);
    setDeclares(loaded.declares);
  }, [load]);

  const currentApp = appKey ? apps?.find((held) => held.key === appKey && held.owned) : undefined;
  useRefreshOnFocus(read, Boolean(currentApp?.setup));

  const goBackToApps = useCallback(
    (replace = false) => {
      void navigate({
        to: "/w/$workspaceSlug/settings",
        params: { workspaceSlug },
        search: { section: "applications", appsTab: "mine" },
        replace,
      });
    },
    [navigate, workspaceSlug],
  );

  async function refreshingWhenStale(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      if (isAppErrorCode(cause, "NOT_FOUND") || isPermissionsChanged(cause)) {
        await read().catch(() => undefined);
      }
      throw cause;
    }
  }

  async function submit(
    { input, permissionGroups, notificationEvents, setup, stayOpen }: AppEditorSubmission,
    releaseGuard: () => void,
  ) {
    if (currentApp) {
      const { key: _key, ...patch } = input;
      const { key } = currentApp;
      await refreshingWhenStale(async () => {
        const updated = await update({
          data: { key, patch, permissionGroups, notificationEvents, setup },
        });
        setApps((current) => current?.map((held) => (held.key === updated.key ? updated : held)));
        if (!stayOpen) {
          releaseGuard();
          goBackToApps();
        }
      });
      return;
    }
    const { app, clientSecret } = await register({
      data: { ...input, permissionGroups, notificationEvents, setup },
    });
    stashIssuedAppSecret({ key: app.key, appName: app.name, secret: clientSecret });
    releaseGuard();
    await navigate({
      to: "/w/$workspaceSlug/settings/apps/$appKey",
      params: { workspaceSlug, appKey: app.key },
      replace: true,
    });
  }

  const regenerate = (app: AppSummary) =>
    refreshingWhenStale(async () => {
      const { clientSecret } = await rotate({ data: { key: app.key } });
      setIssued({ key: app.key, appName: app.name, secret: clientSecret });
    });

  const deleteApp = (app: AppSummary, releaseGuard: () => void) =>
    refreshingWhenStale(async () => {
      await remove({ data: { key: app.key } });
      setIssued(null);
      releaseGuard();
      goBackToApps(true);
    });

  function showLogo(key: string, logoUrl: string | null) {
    setApps((current) => current?.map((held) => (held.key === key ? { ...held, logoUrl } : held)));
  }

  const uploadAppLogo = (app: AppSummary, file: File) =>
    refreshingWhenStale(async () => {
      const form = new FormData();
      form.set("key", app.key);
      form.set("file", file);
      showLogo(app.key, (await uploadLogo({ data: form })).logoUrl);
    });

  const resetAppLogo = (app: AppSummary) =>
    refreshingWhenStale(async () => {
      showLogo(app.key, (await resetLogo({ data: { key: app.key } })).logoUrl);
    });

  const approvePermissions = (app: AppSummary, revision: number) =>
    refreshingWhenStale(async () => {
      const permissions = await approve({ data: { key: app.key, revision } });
      setApps((current) =>
        current?.map((held) => (held.key === app.key ? { ...held, permissions } : held)),
      );
    });

  const publishing = useAppPublishing(setApps, refreshingWhenStale);

  return (
    <AppEditor
      key={appKey ?? "new"}
      app={currentApp}
      declares={declares}
      issued={issued && currentApp && issued.key === currentApp.key ? issued : null}
      onBack={() => goBackToApps()}
      onSubmit={submit}
      onRegenerate={regenerate}
      onDelete={deleteApp}
      onUploadLogo={uploadAppLogo}
      onResetLogo={resetAppLogo}
      onApprovePermissions={approvePermissions}
      onRefreshSetup={read}
      onRequestPublish={publishing.requestPublish}
      onWithdrawPublish={publishing.withdrawPublish}
      onRequestUnpublish={publishing.requestUnpublish}
    />
  );
}
