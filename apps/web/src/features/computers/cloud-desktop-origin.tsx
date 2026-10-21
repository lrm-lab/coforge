import { createContext, useContext, type ReactNode } from "react";

const CloudDesktopOriginContext = createContext<string | null>(null);

/** Shares this deployment's desktop proxy origin with the detail header. */
export function CloudDesktopOriginProvider({
  origin,
  children,
}: {
  origin: string | null;
  children: ReactNode;
}) {
  return (
    <CloudDesktopOriginContext.Provider value={origin}>
      {children}
    </CloudDesktopOriginContext.Provider>
  );
}

export function useCloudDesktopOrigin(): string | null {
  return useContext(CloudDesktopOriginContext);
}
