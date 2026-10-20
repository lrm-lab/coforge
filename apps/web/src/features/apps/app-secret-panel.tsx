import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { CopyValueButton } from "./copy-value-button";

/** A new client secret for one app, from a register or a regenerate. */
export type IssuedSecret = { appName: string; secret: string };

/** Shows a client secret the one time it exists outside the server. The caller drops it on the
 * next register, on opening another app, or with the page; nothing else keeps it. */
export function AppSecretPanel({ issued }: { issued: IssuedSecret }) {
  return (
    <Alert
      color="success"
      title={m.apps_secret_title({ name: issued.appName })}
      description={
        <span className="grid gap-2">
          <span>{m.apps_secret_once()}</span>
          <span className="flex min-w-0 items-center gap-2 rounded-lg bg-primary py-1.5 pr-1.5 pl-3 ring-1 ring-secondary ring-inset">
            <code className="min-w-0 flex-1 font-mono text-sm break-all text-primary">
              {issued.secret}
            </code>
            <CopyValueButton value={issued.secret} label={m.apps_copy_client_secret()} />
          </span>
        </span>
      }
    />
  );
}
