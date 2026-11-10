import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { backTargetOf } from "#src/components/layout/tab-home";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";
import { m } from "#src/paraglide/messages";

/**
 * An inner page's way out on a phone, where the tab bar is hidden: back to the tab home the page
 * belongs to (`backTargetOf`), else one step back in the app's own history, else the Chat list.
 * A desktop has the sidebar, so it never shows there.
 */
export function PageBackButton() {
  const router = useRouter();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const target = useRouterState({
    select: (state) =>
      backTargetOf(splitWorkspacePath(state.location.pathname)?.rest.split("/")[1] ?? ""),
  });
  const goBack = () => {
    if (target === "workspace")
      void navigate({ to: "/w/$workspaceSlug/workspace", params: { workspaceSlug } });
    else if (target === "me")
      void navigate({ to: "/w/$workspaceSlug/me", params: { workspaceSlug } });
    else if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } });
  };
  return (
    <ButtonUtility
      icon={ArrowLeft}
      size="sm"
      color="tertiary"
      aria-label={m.controls_back()}
      onClick={goBack}
      className="-ml-2 shrink-0 lg:hidden"
    />
  );
}
