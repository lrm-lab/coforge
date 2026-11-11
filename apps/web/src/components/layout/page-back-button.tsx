import { useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { backTargetOf, sectionOf } from "#src/components/layout/tab-home";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";

/**
 * An inner page's way out on a phone, where the tab bar is hidden: back to the tab home the page
 * belongs to (`backTargetOf`), else one step back in the app's own history, else the Chat list.
 * A desktop has the sidebar, so it is not mounted there (a hidden copy would still be a "Back"
 * button in the page). The page is read when pressed, so the button does not re-render on every
 * navigation.
 */
export function PageBackButton() {
  const router = useRouter();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const desktop = useBreakpoint("lg");
  const goBack = () => {
    const target = backTargetOf(sectionOf(router.state.location.pathname));
    if (target === "workspace")
      void navigate({ to: "/w/$workspaceSlug/workspace", params: { workspaceSlug } });
    else if (target === "me")
      void navigate({ to: "/w/$workspaceSlug/me", params: { workspaceSlug } });
    else if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug } });
  };
  if (desktop) return null;
  return (
    <ButtonUtility
      icon={ArrowLeft}
      size="sm"
      color="tertiary"
      aria-label={m.controls_back()}
      onClick={goBack}
      className="-ml-2 shrink-0"
    />
  );
}
