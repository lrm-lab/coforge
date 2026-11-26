import { z } from "zod";
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

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const pageQuerySchema = z.strictObject({
  where: z
    .record(z.string(), z.unknown())
    .refine((record) => Object.keys(record).length <= PAGE_QUERY_CONDITIONS_MAX)
    .optional(),
  orderBy: z
    .strictObject({
      field: z.unknown().optional(),
      direction: z.enum(["asc", "desc"]).optional(),
    })
    .optional(),
  limit: z.int().min(1).max(PAGE_QUERY_MAX).optional(),
  after: z.string().max(2048).optional(),
});

export function pageQuery(value: unknown): Query {
  const parsed = pageQuerySchema.safeParse(value === undefined ? {} : value);
  if (!parsed.success) return invalid("artifact-data-query");
  const { where = {}, orderBy, limit = PAGE_QUERY_DEFAULT, after } = parsed.data;
  const checked = Object.entries(where).map(([field, expected]): [string, Scalar] => {
    pageField(field);
    const scalar = scalarSchema.safeParse(expected);
    return scalar.success ? [field, scalar.data] : invalid("artifact-data-query");
  });
  const order = orderBy
    ? { field: pageField(orderBy.field), descending: orderBy.direction === "desc" }
    : null;
  return { where: checked, orderBy: order, limit, after: after ?? null };
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
