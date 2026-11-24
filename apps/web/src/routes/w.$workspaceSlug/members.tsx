import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { AgentsContent } from "#src/features/agents/agents-content";
import { AgentsPending } from "#src/features/agents/agents-pending";
import { ensureWeeklyReportAssistantMember } from "#src/features/agents/agents.functions";
import { useLiveAgents } from "#src/features/agents/workspace-agents-realtime";
import { loadMemberDirectorySummary } from "#src/features/workspaces/workspaces.functions";
import {
  memberAgentsQuery,
  memberPeopleQuery,
} from "#src/features/agents/member-directory-queries";
import {
  agentIdFromProfileParam,
  agentProfileTabParamSchema,
  profileParamSchema,
  personIdFromProfileParam,
} from "#src/features/agents/profile-panel/profile-panel-search";

export const Route = createFileRoute("/w/$workspaceSlug/members")({
  validateSearch: z.object({
    memberType: z.enum(["all", "agent", "human"]).default("all").catch("all"),
    owner: z.enum(["all", "mine"]).default("all").catch("all"),
    agentView: z.enum(["list", "usage"]).default("list").catch("list"),
    profile: profileParamSchema,
    agentTab: agentProfileTabParamSchema,
    setup: z.enum(["create-agent", "invite"]).optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({
    memberType: search.memberType,
    owner: search.owner,
  }),
  loader: async ({ context, deps }) => {
    const assistant = await ensureWeeklyReportAssistantMember();
    const summary = await loadMemberDirectorySummary();
    if (deps.memberType === "all") {
      await Promise.all([
        context.queryClient.ensureInfiniteQueryData(memberPeopleQuery(summary.workspaceId, "")),
        context.queryClient.ensureInfiniteQueryData(
          memberAgentsQuery(summary.workspaceId, {
            owner: "all",
            query: "",
          }),
        ),
      ]);
    } else if (deps.memberType === "agent") {
      await context.queryClient.ensureInfiniteQueryData(
        memberAgentsQuery(summary.workspaceId, {
          owner: deps.owner,
          query: "",
        }),
      );
    } else {
      await context.queryClient.ensureInfiniteQueryData(memberPeopleQuery(summary.workspaceId, ""));
    }
    return { summary, weeklyReportAssistantAgentId: assistant.agentId };
  },
  pendingComponent: AgentsPending,
  errorComponent: PageLoadError,
  component: AgentsPage,
});

function AgentsPage() {
  const { summary, weeklyReportAssistantAgentId } = Route.useLoaderData();
  const { memberType, owner, agentView, profile, agentTab, setup } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const visibleAgents = useLiveAgents();

  useEffect(() => {
    if (!weeklyReportAssistantAgentId) return;
    if (visibleAgents.some((agent) => agent.id === weeklyReportAssistantAgentId)) return;
    void router.invalidate({ sync: true });
  }, [weeklyReportAssistantAgentId, visibleAgents, router]);

  return (
    <AgentsContent
      summary={summary}
      memberType={memberType}
      owner={owner}
      agentView={agentView}
      onFiltersChange={(filters) => {
        void navigate({
          search: (previous) => ({ ...previous, ...filters }),
          resetScroll: false,
        });
      }}
      profileAgentId={agentIdFromProfileParam(profile)}
      profilePersonId={personIdFromProfileParam(profile)}
      agentTab={agentTab}
      dialog={setup}
      onDialogChange={(dialog) => {
        void navigate({
          search: (previous) => ({ ...previous, setup: dialog }),
          resetScroll: false,
        });
      }}
    />
  );
}
