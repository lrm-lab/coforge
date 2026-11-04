import type { Prisma } from "#src/generated/prisma/client";

/**
 * What the project page reads of a Project: its own fields. `satisfies` makes a field removed
 * from the schema a type error here instead of a failure of every project page at run time.
 */
export const projectDetailSelect = () =>
  ({
    id: true,
    name: true,
    slug: true,
    description: true,
    iconObjectKey: true,
    githubFullName: true,
    githubHtmlUrl: true,
    commitCoAuthor: true,
  }) satisfies Prisma.ProjectSelect;

/** What the projects index reads of each Project. */
export const projectListSelect = () =>
  ({
    id: true,
    name: true,
    slug: true,
    iconObjectKey: true,
  }) satisfies Prisma.ProjectSelect;
