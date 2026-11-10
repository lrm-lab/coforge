import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";

/** Official nav components render plain `<a href>` with no onClick hook, so
 * this routes same-origin, unmodified clicks through the router instead. */
function useSpaNavigation() {
  const router = useRouter();
  return useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      void router.navigate({ href: url.pathname + url.search + url.hash });
    },
    [router],
  );
}

/** The shell's own links (the top bar's, the sidebars', the tab bar's and the hub's), routed
 * through the router. */
export function ShellLinks({ children }: { children: React.ReactNode }) {
  const onClickCapture = useSpaNavigation();
  return (
    <div onClickCapture={onClickCapture} className="contents">
      {children}
    </div>
  );
}
