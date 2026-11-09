import { Link, useParams } from "@tanstack/react-router";
import { PageHeader } from "#src/components/layout/page-header";
import { m } from "#src/paraglide/messages";

/** Replaces the whole Workbench page while the Workspace's switch is off. */
export function PiChatOff() {
  const { workspaceSlug } = useParams({ strict: false });
  return (
    <main className="flex h-full min-h-0 flex-col">
      <PageHeader heading={m.pi_chat_title()} />
      <div role="status" className="flex flex-col items-start gap-2 p-page">
        <p className="text-sm text-primary">{m.pi_chat_off()}</p>
        {workspaceSlug && (
          <Link
            to="/w/$workspaceSlug/settings"
            params={{ workspaceSlug }}
            search={{ section: "experiments" }}
            className="text-sm text-brand-secondary"
          >
            {m.pi_chat_off_settings()}
          </Link>
        )}
      </div>
    </main>
  );
}
