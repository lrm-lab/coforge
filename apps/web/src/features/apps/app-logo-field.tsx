import { useRef, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { isAppErrorCode } from "#src/lib/app-error";
import { APP_LOGO_UPLOAD_TYPES, IMAGE_MAX_BYTES } from "#src/lib/image-upload";
import { m } from "#src/paraglide/messages";
import { AppLogo } from "./app-logo";

const ACCEPT = APP_LOGO_UPLOAD_TYPES.join(",");
const takes = (file: File) =>
  (APP_LOGO_UPLOAD_TYPES as readonly string[]).includes(file.type) &&
  file.size > 0 &&
  file.size <= IMAGE_MAX_BYTES;

/**
 * The editor's logo: a large preview, then what can be done with it. While registering there is
 * nothing to do yet (the app needs its key first); when editing, an upload replaces the logo at
 * once and Reset goes back to the monogram. Problems stay here, inline.
 */
export function AppLogoField({
  name,
  logo,
  isDisabled,
}: {
  name: string;
  /** Absent while registering. When editing: the logo's URL (none: the monogram), and the two
   * changes, which throw when refused. */
  logo?: {
    url: string | null;
    upload: (file: File) => Promise<void>;
    reset: () => Promise<void>;
  };
  isDisabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<"upload" | "reset" | null>(null);
  const [problem, setProblem] = useState("");

  async function run(kind: "upload" | "reset", action: () => Promise<void>) {
    setPending(kind);
    setProblem("");
    try {
      await action();
    } catch (cause) {
      setProblem(
        isAppErrorCode(cause, "INVALID_INPUT") ? m.apps_logo_invalid() : m.apps_logo_error(),
      );
    } finally {
      setPending(null);
    }
  }

  function chosen(upload: (file: File) => Promise<void>, file: File) {
    if (!takes(file)) return setProblem(m.apps_logo_invalid());
    void run("upload", () => upload(file));
  }

  const busy = isDisabled || pending !== null;
  return (
    <div className="flex items-center gap-4">
      <AppLogo name={name || "?"} url={logo?.url ?? null} size="lg" />
      <div className="grid min-w-0 flex-1 gap-2">
        <div className="grid gap-0.5">
          <p className="text-sm font-medium text-secondary">{m.apps_logo_label()}</p>
          <p className="text-sm text-tertiary">
            {logo ? m.apps_logo_hint_edit() : m.apps_logo_hint_register()}
          </p>
        </div>
        {logo && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              color="secondary"
              isDisabled={busy}
              isLoading={pending === "upload"}
              showTextWhileLoading
              onPress={() => input.current?.click()}
            >
              {pending === "upload"
                ? m.apps_logo_uploading()
                : logo.url
                  ? m.apps_logo_change()
                  : m.apps_logo_upload()}
            </Button>
            {logo.url && (
              <Button
                type="button"
                size="sm"
                color="tertiary"
                isDisabled={busy}
                isLoading={pending === "reset"}
                showTextWhileLoading
                onPress={() => void run("reset", logo.reset)}
              >
                {m.apps_logo_reset()}
              </Button>
            )}
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) chosen(logo.upload, file);
              }}
            />
          </div>
        )}
        {problem && (
          <p role="alert" className="text-sm text-error-primary">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
