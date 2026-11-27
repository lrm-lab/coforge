import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getComputerCodexCompatible } from "./computers.functions";

export function useCodexCompatibleSupport(computerId: string, enabled: boolean): boolean {
  const read = useServerFn(getComputerCodexCompatible);
  const query = useQuery({
    queryKey: ["computer-codex-compatible", computerId],
    queryFn: () => read({ data: { computerId } }),
    enabled: enabled && Boolean(computerId),
    staleTime: 30_000,
    retry: false,
  });
  return query.data === true;
}
