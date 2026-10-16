import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { StatusDot } from "#src/components/ui/status-dot";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { isAppErrorCode } from "#src/lib/app-error";
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

export function ServerConnectionSettings() {
  const [page, setPage] = useState<Page | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<UnlockReason | null>(null);
  const [pending, guard] = useSubmitGuard();
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
    const interval = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(interval);
  }, [page, load]);

  function continueWithPassword() {
    setError(null);
    void guard(async () => {
      try {
        const result = await unlock({ data: { password } });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setPassword("");
        setPage(result.page);
      } catch {
        setError("unavailable");
      }
    });
  }

  if (!page) {
    return (
      <form
        className="max-w-sm space-y-4 px-4 py-6 sm:px-8"
        onSubmit={(event) => {
          event.preventDefault();
          continueWithPassword();
        }}
      >
        <Input
          label={m.settings_cloud_service_password_label()}
          hint={m.settings_cloud_service_password_hint()}
          type="password"
          name="password"
          autoComplete="current-password"
          isRequired
          value={password}
          onChange={setPassword}
        />
        <Button type="submit" isDisabled={pending || password.length === 0}>
          {pending
            ? m.settings_cloud_service_password_checking()
            : m.settings_cloud_service_password_continue()}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-error-primary">
            {passwordError(error)}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <div className="space-y-8 px-4 py-6 text-sm sm:px-8">
      <div className="flex max-w-2xl items-start justify-between gap-4">
        <p className="text-tertiary">{m.settings_cloud_service_intro()}</p>
        <Button
          type="button"
          color="secondary"
          size="sm"
          onPress={() => {
            setPage(null);
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
      <InstallHost clusterName={page.clusterName} download={download} />
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
  const [clusterName, setClusterName] = useState(initialClusterName ?? "");
  const [image, setImage] = useState("");
  const [error, setError] = useState<DownloadReason | null>(null);
  const [pending, guard] = useSubmitGuard();

  function saveScript() {
    setError(null);
    void guard(async () => {
      try {
        const result = await download({ data: { clusterName, image } });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        const url = URL.createObjectURL(new Blob([result.script], { type: "text/x-shellscript" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = result.filename;
        link.click();
        URL.revokeObjectURL(url);
      } catch {
        setError("failed");
      }
    });
  }

  return (
    <form
      className="max-w-2xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        saveScript();
      }}
    >
      <div className="space-y-2">
        <h2 className="font-medium text-primary">{m.settings_cloud_service_install_title()}</h2>
        <p className="text-tertiary">{m.settings_cloud_service_install_body()}</p>
      </div>
      <Input
        label={m.settings_cloud_service_cluster_name()}
        name="clusterName"
        isRequired
        value={clusterName}
        onChange={setClusterName}
      />
      <Input
        label={m.settings_cloud_service_image()}
        hint={m.settings_cloud_service_image_hint()}
        name="image"
        placeholder="coforge-computer:staging"
        isRequired
        value={image}
        onChange={setImage}
      />
      <Button type="submit" isDisabled={pending || clusterName.length === 0 || image.length === 0}>
        {pending ? m.settings_cloud_service_downloading() : m.settings_cloud_service_download()}
      </Button>
      {error ? (
        <p role="alert" className="text-error-primary">
          {downloadError(error)}
        </p>
      ) : null}
    </form>
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
