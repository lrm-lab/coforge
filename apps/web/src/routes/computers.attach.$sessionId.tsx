import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { EmptyState } from "#src/components/ui/empty";
import { LockedWireframe } from "#src/components/ui/empty-wireframes";
import { AttachApprovePage } from "#src/features/computers/attach-approve";
import { readComputerAttach } from "#src/features/computers/attach-approve.functions";
import { ErrorPageFrame } from "#src/features/errors/error-page-frame";
import { m } from "#src/paraglide/messages";

export const Route = createFileRoute("/computers/attach/$sessionId")({
  loader: async ({ params }) => ({
    session: await readComputerAttach({ data: { sessionId: params.sessionId } }),
  }),
  component: Approve,
});

function Approve() {
  const { session } = Route.useLoaderData();
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  if (!session)
    return (
      <ErrorPageFrame>
        <EmptyState
          size="page"
          headingLevel={1}
          picture={<LockedWireframe />}
          title={m.empty_attach_not_found_title()}
          description={m.empty_attach_not_found_description()}
          primaryAction={
            <Button size="sm" color="tertiary" onPress={() => void navigate({ to: "/" })}>
              {m.workspace_join_back()}
            </Button>
          }
        />
      </ErrorPageFrame>
    );
  return <AttachApprovePage sessionId={sessionId} {...session} />;
}
