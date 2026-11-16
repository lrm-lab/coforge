import { BookOpen01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useWorkspaceExperiments } from "#src/features/settings/experiments-settings";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";

/** Team memory remains reachable for members who have no Agent of their own. */
export function TeamMemoryMenuItem() {
  const experiments = useWorkspaceExperiments();
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate();
  if (
    !experiments.data?.experiments.some((entry) => entry.key === "platformMemory" && entry.enabled)
  )
    return null;
  return (
    <Dropdown.Item
      id="team-memory"
      icon={BookOpen01}
      label={m.memory_team()}
      onAction={() => void navigate({ to: "/w/$workspaceSlug/memory", params: { workspaceSlug } })}
    />
  );
}
