import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { readComputerInstallerRecovery } from "./computer-installer-recovery.functions";

export function InstallerRecoveryAdvice({
  computerId,
  command,
}: {
  computerId: string;
  command: ReactNode;
}) {
  const workspace = useWorkspaceSlug();
  const read = useServerFn(readComputerInstallerRecovery);
  const { data: deadline, isError } = useQuery({
    queryKey: ["computer-installer-recovery", workspace, computerId],
    queryFn: async () => {
      const startedAt = Date.now();
      const result = await read({ data: { computerId } });
      return result ? startedAt + result.remainingMs : null;
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const [expired, setExpired] = useState<number | undefined>();
  useEffect(() => {
    if (!deadline) return;
    const timer = setTimeout(() => setExpired(deadline), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);

  if (isError || !deadline || expired === deadline || deadline <= Date.now()) return null;
  return (
    <p className="mt-2 text-secondary">
      {m.computer_upgrade_installer_recovery()} {command}
    </p>
  );
}
