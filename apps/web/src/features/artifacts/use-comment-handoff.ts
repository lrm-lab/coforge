import { useCallback, useEffect, useState } from "react";

export function useCommentHandoff<T>(
  stillWanted: (request: T) => boolean,
): [T | null, (request: T) => void, () => void] {
  const [request, setRequest] = useState<T | null>(null);
  const consume = useCallback(() => setRequest(null), []);
  const wanted = request !== null && stillWanted(request);
  useEffect(() => {
    if (request !== null && !wanted) setRequest(null);
  }, [request, wanted]);
  return [wanted ? request : null, setRequest, consume];
}
