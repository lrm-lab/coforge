import { parseCliFlags } from "./cli-flags";

export type MessageSearchOptions = {
  query?: string;
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
};

export function parseMessageSearchArgs(args: readonly string[]): MessageSearchOptions {
  const { values } = parseCliFlags({
    args: args.slice(2),
    options: {
      query: { type: "string" },
      target: { type: "string", multiple: true },
      channel: { type: "string", multiple: true },
      sender: { type: "string" },
      sort: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      cursor: { type: "string" },
    },
    allowEmptyValues: false,
    onError() {
      throw new Error("Usage:");
    },
  });
  const options: MessageSearchOptions = {};
  if (values.limit !== undefined) {
    const number = Number(values.limit);
    if (!Number.isInteger(number) || number < 1) throw new Error("Usage:");
    options.limit = number;
  }
  if (values.offset !== undefined) {
    const number = Number(values.offset);
    if (!Number.isInteger(number) || number < 0) throw new Error("Usage:");
    options.offset = number;
  }
  if (values.cursor !== undefined) options.cursor = values.cursor;
  if (values.sort !== undefined) {
    if (values.sort !== "relevance" && values.sort !== "recent") throw new Error("Usage:");
    options.sort = values.sort;
  }
  if (values.query !== undefined) options.query = values.query.trim() || undefined;
  for (const value of [...(values.target ?? []), ...(values.channel ?? [])]) {
    if (options.target && options.target !== value) throw new Error("Usage:");
    options.target = value;
  }
  if (values.sender !== undefined)
    options.sender = values.sender.startsWith("@") ? values.sender : `@${values.sender}`;
  if (values.before !== undefined) options.before = values.before;
  if (values.after !== undefined) options.after = values.after;
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
