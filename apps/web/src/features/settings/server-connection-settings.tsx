import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { setFieldServerError, useAppForm } from "#src/components/ui/form";
import { StatusDot } from "#src/components/ui/status-dot";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { isAppErrorCode } from "#src/lib/app-error";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import {
  downloadHostBootstrap,
  loadCloudComputerService,
  lockCloudComputerService,
  unlockCloudComputerService,
} from "#src/features/settings/server-connection.functions";

type Page = Awaited<ReturnType<typeof loadCloudComputerService>>;
type UnlockReason = "rejected" | "unconfigured" | "limited" | "unavailable";
type DownloadReason = "no-feed" | "no-token" | "invalid" | "failed";

const CLOUD_SERVICE_INPUT_MAX_LENGTH = 200;

export function ServerConnectionSettings() {
  const [page, setPage] = useState<Page | null>(null);
  const [initialClusterName, setInitialClusterName] = useState<string | null>(null);
  const unlock = useServerFn(unlockCloudComputerService);
  const load = useServerFn(loadCloudComputerService);
  const lock = useServerFn(lockCloudComputerService);
  const download = useServerFn(downloadHostBootstrap);

  useEffect(() => {
    if (!page) return;
    const refresh = () => {
      void load()
        .then((next) => setPage(next))
        .catch((cause: unknown) => {
          if (isAppErrorCode(cause, "ACCESS_DENIED")) setPage(null);
        });
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [page, load]);

  if (!page) {
    return (
      <UnlockForm
        unlock={unlock}
        onUnlocked={(nextPage, clusterName) => {
          setPage(nextPage);
          setInitialClusterName(clusterName);
        }}
      />
    );
  }

  return (
    <div className="space-y-8 px-page py-6 text-sm">
      <div className="flex max-w-2xl items-start justify-between gap-4">
        <p className="text-tertiary">{m.settings_cloud_service_intro()}</p>
        <Button
          type="button"
          color="secondary"
          size="sm"
          onPress={() => {
            setPage(null);
            setInitialClusterName(null);
            void lock();
          }}
        >
          {m.settings_cloud_service_lock()}
        </Button>
      </div>
      <section className="max-w-2xl">
        <h2 className="font-medium text-primary">{m.settings_server_connection_status()}</h2>
        <p className="mt-2 flex items-center gap-2 text-primary">
          <StatusDot tone={page.connected ? "online" : "offline"} className="size-2" />
          {page.connected
            ? m.settings_server_connection_online()
            : m.settings_server_connection_offline()}
        </p>
      </section>
      <InstallHost clusterName={initialClusterName} download={download} />
      <section className="max-w-2xl space-y-2">
        <h2 className="font-medium text-primary">{m.settings_cloud_service_checks_title()}</h2>
        <ul className="list-disc space-y-1 pl-5 text-tertiary">
          <li>{m.settings_cloud_service_check_service()}</li>
          <li>{m.settings_cloud_service_check_light()}</li>
          <li>{m.settings_cloud_service_check_computer()}</li>
        </ul>
      </section>
    </div>
  );
}

function UnlockForm({
  unlock,
  onUnlocked,
}: {
  unlock: (input: {
    data: { password: string };
  }) => Promise<
    { ok: true; page: Page; clusterName: string | null } | { ok: false; reason: UnlockReason }
  >;
  onUnlocked: (page: Page, clusterName: string | null) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [formError, setFormError] = useState<UnlockReason | null>(null);
  const [pending, guard] = useSubmitGuard();

  const form = useAppForm({
    defaultValues: { password: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (value.password.length === 0) return;
      await guard(async () => {
        setFormError(null);
        try {
          const result = await unlock({ data: { password: value.password } });
          if (!result.ok) {
            if (result.reason === "rejected") {
              setFieldServerError(form, "password", passwordError(result.reason), formRef.current);
            } else {
              setFormError(result.reason);
            }
            return;
          }
          form.reset();
          onUnlocked(result.page, result.clusterName);
        } catch {
          setFormError("unavailable");
        }
      });
    },
  });

  return (
    <form.AppForm>
      <form
        ref={formRef}
        className="max-w-sm space-y-4 px-page py-6"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.AppField name="password">
          {(field) => (
            <field.Input
              label={m.settings_cloud_service_password_label()}
              hint={m.settings_cloud_service_password_hint()}
              type="password"
              autoComplete="current-password"
              isRequired
              maxLength={CLOUD_SERVICE_INPUT_MAX_LENGTH}
              onChange={() => setFormError(null)}
            />
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.password.length === 0}>
          {(empty) => (
            <Button type="submit" size="sm" isDisabled={pending || empty}>
              {pending
                ? m.settings_cloud_service_password_checking()
                : m.settings_cloud_service_password_continue()}
            </Button>
          )}
        </form.Subscribe>
        <form.Alert error={formError ? passwordError(formError) : undefined} />
      </form>
    </form.AppForm>
  );
}

function InstallHost({
  clusterName: initialClusterName,
  download,
}: {
  clusterName: string | null;
  download: (input: {
    data: { clusterName: string; image: string };
  }) => Promise<
    | { ok: true; filename: string; script: string }
    | { ok: false; reason: "no-feed" | "no-token" | "invalid" }
  >;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [formError, setFormError] = useState<DownloadReason | null>(null);
  const [pending, guard] = useSubmitGuard();

  const form = useAppForm({
    defaultValues: { clusterName: initialClusterName ?? "", image: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (value.clusterName.length === 0 || value.image.length === 0) return;
      await guard(async () => {
        setFormError(null);
        try {
          const result = await download({
            data: { clusterName: value.clusterName, image: value.image },
          });
          if (!result.ok) {
            setFormError(result.reason);
            return;
          }
          const url = URL.createObjectURL(
            new Blob([result.script], { type: "text/x-shellscript" }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = result.filename;
          link.click();
          URL.revokeObjectURL(url);
        } catch {
          setFormError("failed");
        }
      });
    },
  });

  return (
    <form.AppForm>
      <form
        ref={formRef}
        className="max-w-2xl space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="space-y-2">
          <h2 className="font-medium text-primary">{m.settings_cloud_service_install_title()}</h2>
          <p className="text-tertiary">{m.settings_cloud_service_install_body()}</p>
        </div>
        <form.AppField name="clusterName">
          {(field) => (
            <field.Input
              label={m.settings_cloud_service_cluster_name()}
              isRequired
              maxLength={CLOUD_SERVICE_INPUT_MAX_LENGTH}
              onChange={() => setFormError(null)}
            />
          )}
        </form.AppField>
        <form.AppField name="image">
          {(field) => (
            <field.Input
              label={m.settings_cloud_service_image()}
              hint={m.settings_cloud_service_image_hint()}
              placeholder="coforge-computer:staging"
              isRequired
              maxLength={CLOUD_SERVICE_INPUT_MAX_LENGTH}
              onChange={() => setFormError(null)}
            />
          )}
        </form.AppField>
        <form.Subscribe
          selector={(state) =>
            state.values.clusterName.length === 0 || state.values.image.length === 0
          }
        >
          {(empty) => (
            <Button type="submit" size="sm" isLoading={pending} isDisabled={pending || empty}>
              {m.settings_cloud_service_download()}
            </Button>
          )}
        </form.Subscribe>
        <form.Alert error={formError ? downloadError(formError) : undefined} />
      </form>
    </form.AppForm>
  );
}

function downloadError(reason: DownloadReason): string {
  if (reason === "no-feed") return m.settings_cloud_service_download_no_feed();
  if (reason === "no-token") return m.settings_cloud_service_download_no_token();
  if (reason === "invalid") return m.settings_cloud_service_download_invalid();
  return m.settings_cloud_service_download_failed();
}

function passwordError(reason: UnlockReason): string {
  if (reason === "unconfigured") return m.settings_cloud_service_password_unconfigured();
  if (reason === "limited") return m.settings_cloud_service_password_limited();
  if (reason === "unavailable") return m.settings_cloud_service_password_unavailable();
  return m.settings_cloud_service_password_rejected();
}
