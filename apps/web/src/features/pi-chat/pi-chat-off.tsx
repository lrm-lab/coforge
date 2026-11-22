import { useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { EmptyState } from "#src/components/ui/empty";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
import { m } from "#src/paraglide/messages";

export function PiChatOff() {
  const { workspaceSlug } = useParams({ strict: false });
  const navigate = useNavigate();
  return (
    <main className="flex h-full min-h-0 flex-col bg-primary">
      <PageHeader heading={m.pi_chat_title()} />
      <EmptyState
        role="status"
        picture={<LockedWireframe />}
        title={m.pi_chat_off()}
        primaryAction={
          workspaceSlug ? (
            <Button
              size="sm"
              color="primary"
              onPress={() =>
                void navigate({
                  to: "/w/$workspaceSlug/settings",
                  params: { workspaceSlug },
                  search: { section: "experiments" },
                })
              }
            >
              {m.pi_chat_off_settings()}
            </Button>
          ) : undefined
        }
      />
    </main>
  );
}
