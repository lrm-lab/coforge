import { useNavigate } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { EmptyState } from "#src/components/ui/empty";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { BackToComputers } from "./back-to-computers";

export function ComputerNotFound() {
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  return (
    <>
      <PageHeader leading={<BackToComputers />} heading={m.empty_computer_not_found_title()} />
      <EmptyState
        size="page"
        picture={<LockedWireframe />}
        title={m.empty_computer_not_found_title()}
        description={m.computer_not_found_description()}
        primaryAction={
          <Button
            size="sm"
            color="tertiary"
            onPress={() =>
              void navigate({
                to: "/w/$workspaceSlug/computers",
                params: { workspaceSlug },
              })
            }
          >
            {m.empty_computer_not_found_back()}
          </Button>
        }
      />
    </>
  );
}
