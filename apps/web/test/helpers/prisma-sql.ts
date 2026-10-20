/**
 * The real Prisma `$queryRaw` tag flattens a nested `Prisma.sql` fragment's own bind values into
 * the parent statement's parameter list; this test's hand-rolled mock only sees the raw tagged
 * template arguments, so it must flatten the same way to assert on the resulting parameter order.
 */
export function flattenSqlValues(values: unknown[]): unknown[] {
  return values.flatMap((value) =>
    value && typeof value === "object" && "values" in value && "strings" in value
      ? flattenSqlValues((value as { values: unknown[] }).values)
      : [value],
  );
}
