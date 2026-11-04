import { createFileRoute } from "@tanstack/react-router";

import { AttachApprovePage } from "#src/features/computers/attach-approve";
import { readComputerAttach } from "#src/features/computers/attach-approve.functions";

/**
 * Where a `coforge-computer attach` approval link opens (task #417): the machine's reported
 * name, host, OS and code, the workspaces the person may attach it to, and Approve / Refuse.
 * Outside the Workspace layout: the page picks the workspace, and a link pasted from a terminal
 * has to stand alone. The loader's sign-in requirement is the route's, not an instruction.
 */
export const Route = createFileRoute("/computers/attach/$sessionId")({
  loader: async ({ params }) => ({
    session: await readComputerAttach({ data: { sessionId: params.sessionId } }),
  }),
  component: Approve,
});

function Approve() {
  const { session } = Route.useLoaderData();
  const { sessionId } = Route.useParams();
  if (!session)
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">Attach session not found</h1>
        <p className="mt-2 text-sm text-secondary">
          This attach request expired or was decided already. Ask the computer to run
          `coforge-computer attach` again for a fresh link.
        </p>
      </main>
    );
  return <AttachApprovePage sessionId={sessionId} {...session} />;
}
