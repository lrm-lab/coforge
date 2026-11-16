import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  PAGE_QUERY_CONDITIONS_MAX,
  PAGE_QUERY_DEFAULT,
  PAGE_QUERY_MAX,
  pageCollection,
  pageField,
} from "./artifact-page-data-rules.server";

export type PageJson = string | number | boolean | null | PageJson[] | { [key: string]: PageJson };

export type PageDocumentView = {
  collection: string;
  id: string;
  data: PageJson;
  version: number;
  updatedAt: string;
};

export type PageQueryResult = { documents: PageDocumentView[]; next: string | null };

type Row = {
  collection: string;
  docId: string;
  data: unknown;
  version: number;
  updatedAt: Date;
};

type Scalar = string | number | boolean | null;

type Query = {
  where: [string, Scalar][];
  orderBy: { field: string; descending: boolean } | null;
  limit: number;
  after: string | null;
};

const invalid = (errorId: string): never => {
  throw new AppError("INVALID_INPUT", { errorId });
};

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

export function pageQuery(value: unknown): Query {
  const options = value === undefined ? {} : value;
  if (typeof options !== "object" || options === null || Array.isArray(options))
    return invalid("artifact-data-query");
  const { where, orderBy, limit, after, ...rest } = options as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return invalid("artifact-data-query");
  const conditions = where === undefined ? {} : where;
  if (typeof conditions !== "object" || conditions === null || Array.isArray(conditions))
    return invalid("artifact-data-query");
  const entries = Object.entries(conditions);
  if (entries.length > PAGE_QUERY_CONDITIONS_MAX) return invalid("artifact-data-query");
  const checked = entries.map(([field, expected]): [string, Scalar] => {
    pageField(field);
    return isScalar(expected) ? [field, expected] : invalid("artifact-data-query");
  });
  let order: Query["orderBy"] = null;
  if (orderBy !== undefined) {
    if (typeof orderBy !== "object" || orderBy === null || Array.isArray(orderBy))
      return invalid("artifact-data-query");
    const { field, direction, ...extra } = orderBy as Record<string, unknown>;
    if (
      Object.keys(extra).length > 0 ||
      (direction !== undefined && !["asc", "desc"].includes(direction as string))
    )
      return invalid("artifact-data-query");
    order = { field: pageField(field), descending: direction === "desc" };
  }
  const size =
    limit === undefined
      ? PAGE_QUERY_DEFAULT
      : Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= PAGE_QUERY_MAX
        ? (limit as number)
        : invalid("artifact-data-query");
  if (after !== undefined && (typeof after !== "string" || after.length > 2048))
    return invalid("artifact-data-query");
  return {
    where: checked,
    orderBy: order,
    limit: size,
    after: (after as string | undefined) ?? null,
  };
}

const sortValue = (field: string) => Prisma.sql`COALESCE("data" -> ${field}::text, 'null'::jsonb)`;

function readCursor(after: string, ordered: boolean): { id: string; value: unknown } {
  try {
    const [id, value] = JSON.parse(Buffer.from(after, "base64url").toString()) as unknown[];
    if (typeof id === "string" && (ordered ? value !== undefined : value === undefined))
      return { id, value };
  } catch {
    return invalid("artifact-data-cursor");
  }
  return invalid("artifact-data-cursor");
}

export async function queryPageDocuments(
  db: Pick<PrismaClient, "$queryRaw">,
  artifactId: string,
  collectionName: string,
  query: Query,
): Promise<PageQueryResult> {
  const collection = pageCollection(collectionName);
  const conditions = [
    Prisma.sql`"artifactId" = ${artifactId}::uuid`,
    Prisma.sql`"collection" = ${collection}`,
    ...query.where.map(
      ([field, expected]) => Prisma.sql`"data" @> ${JSON.stringify({ [field]: expected })}::jsonb`,
    ),
  ];
  const direction = query.orderBy?.descending ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const compare = query.orderBy?.descending ? Prisma.sql`<` : Prisma.sql`>`;
  if (query.after !== null) {
    const cursor = readCursor(query.after, query.orderBy !== null);
    conditions.push(
      query.orderBy
        ? Prisma.sql`(${sortValue(query.orderBy.field)}, "docId") ${compare} (${JSON.stringify(cursor.value)}::jsonb, ${cursor.id})`
        : Prisma.sql`"docId" > ${cursor.id}`,
    );
  }
  const order = query.orderBy
    ? Prisma.sql`${sortValue(query.orderBy.field)} ${direction}, "docId" ${direction}`
    : Prisma.sql`"docId" ASC`;
  const rows = await db.$queryRaw<(Row & { sortKey: unknown })[]>`
    SELECT "collection", "docId", "data", "version", "updatedAt",
      ${query.orderBy ? sortValue(query.orderBy.field) : Prisma.sql`NULL::jsonb`} AS "sortKey"
    FROM "artifact_page_documents"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY ${order}
    LIMIT ${query.limit + 1}`;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const next =
    rows.length > query.limit && last
      ? Buffer.from(
          JSON.stringify(query.orderBy ? [last.docId, last.sortKey] : [last.docId]),
        ).toString("base64url")
      : null;
  return { documents: page.map(viewOf), next };
}

export const viewOf = (row: Row): PageDocumentView => ({
  collection: row.collection,
  id: row.docId,
  data: row.data as PageJson,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});
