import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { AgentsContent } from "#src/features/agents/agents-content";
import { AgentsPending } from "#src/features/agents/agents-pending";
import { ensureWeeklyReportAssistantMember } from "#src/features/agents/agents.functions";
import { useHasLiveAgent } from "#src/features/agents/workspace-agents-realtime";
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
  loader: async ({ context, deps, parentMatchPromise }) => {
    const ensurePage = (workspaceId: string) => {
      if (deps.memberType === "all") {
        return Promise.all([
          context.queryClient.ensureInfiniteQueryData(memberPeopleQuery(workspaceId, "")),
          context.queryClient.ensureInfiniteQueryData(
            memberAgentsQuery(workspaceId, {
              owner: "all",
              query: "",
            }),
          ),
        ]);
      }
      if (deps.memberType === "agent") {
        return context.queryClient.ensureInfiniteQueryData(
          memberAgentsQuery(workspaceId, {
            owner: deps.owner,
            query: "",
          }),
        );
      }
      return context.queryClient.ensureInfiniteQueryData(memberPeopleQuery(workspaceId, ""));
    };
    const [assistant, summary, prefetchedWorkspaceId] = await Promise.all([
      ensureWeeklyReportAssistantMember(),
      loadMemberDirectorySummary(),
      parentMatchPromise.then(async (parent) => {
        const workspaceId = parent.loaderData?.currentWorkspace?.id;
        if (!workspaceId) return undefined;
        await ensurePage(workspaceId);
        return workspaceId;
      }),
    ]);
    if (prefetchedWorkspaceId !== summary.workspaceId) {
      await ensurePage(summary.workspaceId);
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
  const hasWeeklyReportAssistant = useHasLiveAgent(weeklyReportAssistantAgentId);

  useEffect(() => {
    if (!weeklyReportAssistantAgentId || hasWeeklyReportAssistant) return;
    void router.invalidate({ sync: true });
  }, [weeklyReportAssistantAgentId, hasWeeklyReportAssistant, router]);

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
