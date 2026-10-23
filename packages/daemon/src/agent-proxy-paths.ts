/** Route matchers of the Agent proxy's route table. */

/** Matches one fixed pathname; such a route has no path param. */
export function exactPath(path: string) {
  return (pathname: string) => (pathname === path ? "" : undefined);
}

/** Matches `prefix + param + suffix`, yielding the still-encoded param. */
export function pathParam(prefix: string, suffix = "") {
  return (pathname: string) =>
    pathname.startsWith(prefix) && pathname.endsWith(suffix)
      ? pathname.slice(prefix.length, pathname.length - suffix.length)
      : undefined;
}
