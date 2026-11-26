import { parseArgs as nodeParseArgs } from "node:util";

export type CliFlagOption = {
  type: "string" | "boolean";
  multiple?: boolean;
  allowFlagValue?: boolean;
};

export type CliFlagOptions = Record<string, CliFlagOption>;

type FlagResultValue<Option extends CliFlagOption> = Option extends {
  type: "boolean";
  multiple: true;
}
  ? boolean[] | undefined
  : Option extends { type: "boolean" }
    ? boolean | undefined
    : Option extends { type: "string"; multiple: true }
      ? string[] | undefined
      : Option extends { type: "string" }
        ? string | undefined
        : string | boolean | string[] | boolean[] | undefined;

export type CliFlagValues<Options extends CliFlagOptions> = {
  [Key in keyof Options]: FlagResultValue<Options[Key]>;
};

export type CliFlagError =
  | { kind: "unknown"; raw: string }
  | { kind: "missing-value"; flag: string }
  | { kind: "duplicate"; flag: string }
  | { kind: "unexpected-positional"; value: string }
  | { kind: "unexpected-value"; flag: string };

export function cliFlagBadToken(error: CliFlagError): string {
  if (error.kind === "unknown") return error.raw;
  if (error.kind === "unexpected-positional") return error.value;
  return error.flag;
}

export type ParseCliFlagsConfig<Options extends CliFlagOptions> = {
  args: readonly string[];
  options: Options;
  allowPositionals?: boolean;
  maxPositionals?: number;
  allowEmptyValues?: boolean;
  rejectFlagValues?: boolean;
  duplicates?: "allow" | "error" | "error-strings";
  onError: (error: CliFlagError) => never;
};

export function parseCliFlags<const Options extends CliFlagOptions>(
  config: ParseCliFlagsConfig<Options>,
): { values: CliFlagValues<Options>; positionals: string[] } {
  const {
    args,
    options,
    allowPositionals = false,
    maxPositionals,
    allowEmptyValues = true,
    rejectFlagValues = false,
    duplicates = "allow",
    onError,
  } = config;
  const parsed = nodeParseArgs({
    args: [...args],
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const values: Record<string, unknown> = {};
  const positionals: string[] = [];
  const seen = new Set<string>();
  const positionalLimit = maxPositionals ?? (allowPositionals ? Number.POSITIVE_INFINITY : 0);

  for (const token of parsed.tokens) {
    if (token.kind === "option-terminator") {
      return onError({ kind: "unknown", raw: "--" });
    }
    if (token.kind === "positional") {
      if (positionals.length >= positionalLimit) {
        return onError({ kind: "unexpected-positional", value: token.value });
      }
      positionals.push(token.value);
      continue;
    }
    const spec = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
    if (!spec) {
      return onError({ kind: "unknown", raw: args[token.index] ?? token.rawName });
    }
    if (spec.type === "boolean") {
      if (token.inlineValue) {
        return onError({ kind: "unexpected-value", flag: token.rawName });
      }
      if (!spec.multiple && duplicates === "error" && seen.has(token.name)) {
        return onError({ kind: "duplicate", flag: token.rawName });
      }
      seen.add(token.name);
      if (spec.multiple) {
        const list = (values[token.name] as boolean[] | undefined) ?? [];
        list.push(true);
        values[token.name] = list;
      } else {
        values[token.name] = true;
      }
      continue;
    }
    const value = token.value;
    if (
      value === undefined ||
      (!allowEmptyValues && value === "") ||
      (rejectFlagValues && !spec.allowFlagValue && !token.inlineValue && value.startsWith("--"))
    ) {
      return onError({ kind: "missing-value", flag: token.rawName });
    }
    if (!spec.multiple && duplicates !== "allow" && seen.has(token.name)) {
      return onError({ kind: "duplicate", flag: token.rawName });
    }
    seen.add(token.name);
    if (spec.multiple) {
      const list = (values[token.name] as string[] | undefined) ?? [];
      list.push(value);
      values[token.name] = list;
    } else {
      values[token.name] = value;
    }
  }

  return { values: values as CliFlagValues<Options>, positionals };
}
