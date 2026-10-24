export type MessageSearchOptions = {
  query?: string;
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
  /** A previous page's `nextCursor`; continues a `recent` search with a query. */
  cursor?: string;
};

/** The options of `message search`, from the arguments after `message search`. */
export function parseMessageSearchArgs(args: readonly string[]): MessageSearchOptions {
  const options: MessageSearchOptions = {};
  for (let i = 2; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      !name ||
      ![
        "--query",
        "--target",
        "--channel",
        "--sender",
        "--sort",
        "--before",
        "--after",
        "--limit",
        "--offset",
        "--cursor",
      ].includes(name) ||
      !value
    )
      throw new Error("Usage:");
    if (name === "--limit" || name === "--offset") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < (name === "--limit" ? 1 : 0))
        throw new Error("Usage:");
      if (name === "--limit") options.limit = number;
      else options.offset = number;
    } else if (name === "--cursor") options.cursor = value;
    else if (name === "--sort") {
      if (value !== "relevance" && value !== "recent") throw new Error("Usage:");
      options.sort = value;
    } else if (name === "--query") options.query = value.trim() || undefined;
    else if (name === "--target" || name === "--channel") {
      if (options.target && options.target !== value) throw new Error("Usage:");
      options.target = value;
    } else if (name === "--sender") options.sender = value.startsWith("@") ? value : `@${value}`;
    else if (name === "--before") options.before = value;
    else options.after = value;
  }
  if (!options.query && !options.target && !options.sender && !options.before && !options.after)
    throw new Error("Usage:");
  if (!options.query && options.sort === "relevance") throw new Error("Usage:");
  if (options.limit !== undefined && options.limit > 100) throw new Error("Usage:");
  if (options.cursor !== undefined) {
    if (options.offset !== undefined)
      throw new Error("--cursor already marks where to continue; drop --offset");
    if (!options.query || options.sort !== "recent")
      throw new Error(
        "--cursor continues a recent search: pass a previous nextCursor with the same --query and --sort recent",
      );
  }
  return options;
}
