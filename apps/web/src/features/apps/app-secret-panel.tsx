import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { CopyValueButton } from "./copy-value-button";

/** A new client secret for one app, from a register or a regenerate. */
export type IssuedSecret = { appName: string; secret: string };

/** A secret in a success alert, with a copy button: for a value that exists outside the server
 * only once. */
export function SecretValueAlert({
  title,
  notice,
  value,
  copyLabel,
}: {
  title: string;
  notice: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <Alert
      color="success"
      title={title}
      description={
        <span className="grid gap-2">
          <span>{notice}</span>
          <span className="flex min-w-0 items-center gap-2 rounded-lg bg-primary py-1.5 pr-1.5 pl-3 ring-1 ring-secondary ring-inset">
            <code className="min-w-0 flex-1 font-mono text-sm break-all text-primary">{value}</code>
            <CopyValueButton value={value} label={copyLabel} />
          </span>
        </span>
      }
    />
  );
}

/** Shows a client secret the one time it exists outside the server. The caller drops it on the
 * next register, on opening another app, or with the page; nothing else keeps it. */
export function AppSecretPanel({ issued }: { issued: IssuedSecret }) {
  return (
    <SecretValueAlert
      title={m.apps_secret_title({ name: issued.appName })}
      notice={m.apps_secret_once()}
      value={issued.secret}
      copyLabel={m.apps_copy_client_secret()}
    />
  );
}
