export const PAGE_LEVELS = ["view", "interact", "admin", "owner"] as const;

export type PageLevel = (typeof PAGE_LEVELS)[number];

export const levelReaches = (have: PageLevel, need: PageLevel): boolean =>
  PAGE_LEVELS.indexOf(have) >= PAGE_LEVELS.indexOf(need);

export const PAGE_METHOD_LEVELS: Readonly<Record<string, PageLevel>> = {
  "user.get": "view",
  "artifact.get": "view",
  "clipboard.copy": "view",
  "comments.open": "view",
  "db.get": "view",
  "db.query": "view",
  "db.watch": "view",
  "db.unwatch": "view",
  "db.set": "interact",
  "db.update": "interact",
  "db.delete": "interact",
  "db.batch": "interact",
  "assets.list": "view",
  "assets.upload": "interact",
  "assets.delete": "admin",
};

export const PAGE_NAMESPACES = [
  "user",
  "artifact",
  "clipboard",
  "links",
  "comments",
  "db",
  "assets",
] as const;

export const offeredNamespaces = (level: PageLevel): string[] =>
  PAGE_NAMESPACES.filter(
    (namespace) =>
      namespace === "links" ||
      Object.entries(PAGE_METHOD_LEVELS).some(
        ([key, floor]) => key.startsWith(`${namespace}.`) && levelReaches(level, floor),
      ),
  );
