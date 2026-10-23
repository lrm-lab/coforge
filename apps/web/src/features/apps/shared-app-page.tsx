import { useState } from "react";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, CheckCircle } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Select } from "#src/components/base/select/select";
import { Alert } from "#src/components/ui/alert";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { isAppErrorCode } from "#src/lib/app-error";
import { formatDateForDisplay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { isPermissionsChanged } from "./app-form";
import { AppLogo } from "./app-logo";
import { Field, MarketplaceAppFields } from "./marketplace-app-fields";
import { installSharedApp, type SharedApp } from "./shared-app.functions";

/** The page around a private share link's content: the CoForge mark and one centered column. */
function SharedAppFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-primary px-4 py-8 md:px-8">
      <Link to="/" aria-label="CoForge" className="inline-block">
        <img src="/logo.svg" alt="" className="size-8" />
      </Link>
      <main className="mx-auto grid w-full max-w-2xl gap-6 py-8">{children}</main>
    </div>
  );
}

/** A link that is unknown, revoked, expired or replaced: all the same page, as in Raft. */
function SharedAppNotFound() {
  return (
    <SharedAppFrame>
      <div className="flex flex-col items-center gap-6 text-center">
        <FeaturedIcon icon={AlertCircle} color="error" theme="light" size="lg" />
        <div className="flex flex-col gap-2">
          <h1 className="text-display-xs font-semibold text-primary">
            {m.apps_shared_not_found_title()}
          </h1>
          <p role="alert" className="text-md text-balance text-tertiary">
            {m.apps_shared_not_found_description()}
          </p>
        </div>
        <Button size="lg" color="secondary" iconLeading={ArrowLeft} href="/">
          {m.apps_shared_back()}
        </Button>
      </div>
    </SharedAppFrame>
  );
}

/**
 * The page a private share link opens (`/apps/share/<token>`) for a signed-in person: the app, who
 * shared it, what an install approves (the same fields as the Marketplace detail), and the
 * Workspaces where they own or administer, one of which they install it in. An install goes
 * through the Marketplace's own path, so a declaration that changed meanwhile installs nothing and
 * the page reloads with the current one.
 */
export function SharedAppPage({ token, shared }: { token: string; shared: SharedApp | null }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [target, setTarget] = useState<string | null>(
    shared?.targets.find((t) => !t.installed)?.workspaceId ?? null,
  );
  const [installing, setInstalling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ slug: string; name: string } | null>(null);
  const [gone, setGone] = useState(false);

  if (!shared || gone) return <SharedAppNotFound />;
  const { app, expiresAt, targets } = shared;
  const chosen = targets.find((t) => t.workspaceId === target);

  async function install() {
    if (!chosen) return;
    setInstalling(true);
    setProblem(null);
    try {
      await installSharedApp({
        data: { token, workspaceId: chosen.workspaceId, revision: app.permissionRevision },
      });
      setDone({ slug: chosen.slug, name: chosen.name });
    } catch (cause) {
      if (isAppErrorCode(cause, "NOT_FOUND")) {
        // Revoked or expired since the page loaded.
        setGone(true);
      } else if (isPermissionsChanged(cause)) {
        setProblem(m.apps_marketplace_install_changed());
        await router.invalidate();
      } else {
        setProblem(m.apps_shared_error());
      }
    } finally {
      setInstalling(false);
    }
  }

  return (
    <SharedAppFrame>
      <div className="flex items-start gap-3">
        <AppLogo name={app.name} url={app.logoUrl} size="lg" />
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-medium text-tertiary">{m.apps_shared_eyebrow()}</p>
          <h1 className="text-display-xs font-semibold text-primary wrap-anywhere">
            {m.apps_shared_title({ name: app.name })}
          </h1>
          <p className="text-sm text-tertiary wrap-anywhere">
            {m.apps_shared_by({ developer: app.developer })}
          </p>
        </div>
      </div>
      <div className="grid gap-4 rounded-xl border border-secondary p-4 md:p-6">
        <MarketplaceAppFields app={app} />
        <Field label={m.apps_shared_client_id()}>
          <span className="font-mono text-xs wrap-anywhere text-secondary">{app.key}</span>
        </Field>
        <Field label={m.apps_shared_expiry()}>
          <time dateTime={expiresAt} className="text-sm text-secondary">
            {hydrated ? formatDateForDisplay(expiresAt, null, getLocale()) : ""}
          </time>
        </Field>
      </div>
      {done ? (
        <div className="grid gap-4">
          <Alert
            color="success"
            icon={CheckCircle}
            title={m.apps_shared_installed_title({ name: app.name, workspace: done.name })}
          />
          <Button
            size="lg"
            href={`/w/${done.slug}/settings?appsTab=installed`}
            className="w-full sm:w-fit"
          >
            {m.apps_shared_open()}
          </Button>
        </div>
      ) : targets.length === 0 ? (
        <Alert color="warning" title={m.apps_shared_need_admin()} />
      ) : targets.every((t) => t.installed) ? (
        <Alert color="success" title={m.apps_shared_all_installed()} />
      ) : (
        <div className="grid gap-4">
          <Select
            label={m.apps_shared_target()}
            placeholder={m.apps_shared_target_placeholder()}
            items={targets.map((t) => ({
              id: t.workspaceId,
              label: t.installed ? `${t.name}${m.apps_shared_installed_suffix()}` : t.name,
              isDisabled: t.installed,
            }))}
            selectedKey={target}
            onSelectionChange={(key) => setTarget(String(key))}
            isDisabled={installing}
          >
            {(item) => <Select.Item id={item.id} label={item.label} isDisabled={item.isDisabled} />}
          </Select>
          {chosen?.approvesOnInstall && (
            <p className="text-sm text-tertiary">{m.apps_marketplace_install_records()}</p>
          )}
          {problem && <Alert color="warning" title={problem} />}
          <Button
            size="lg"
            className="w-full sm:w-fit"
            isDisabled={!chosen || chosen.installed || installing}
            isLoading={installing}
            showTextWhileLoading
            onPress={() => void install()}
          >
            {installing ? m.apps_shared_installing() : m.apps_shared_install()}
          </Button>
        </div>
      )}
    </SharedAppFrame>
  );
}
