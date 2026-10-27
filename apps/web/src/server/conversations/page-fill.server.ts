import { AppError } from "#src/lib/app-error";

const ID = /^[A-Za-z0-9_-]+$/;

export type PageFillField = {
  id: string;
  selector: string;
  input: "text" | "password";
};

/**
 * The desktop address that types into one Agent's browser. The origin is the
 * deployment's desktop proxy, which already checks the caller owns the computer.
 */
export function pageFillUrl(
  origin: string,
  computerId: string,
  agentId: string,
): string | undefined {
  if (!ID.test(computerId) || !ID.test(agentId)) return undefined;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return undefined;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return undefined;
  if (!base.hostname || base.username || base.password) return undefined;
  if (base.pathname !== "" && base.pathname !== "/") return undefined;
  if (base.search || base.hash) return undefined;
  return `${base.origin}/desktop/${computerId}/${agentId}/fill`;
}

/** Pair each stored field with the value just submitted. The result is sent once and not stored. */
export function pageFillRequestFields(
  fields: readonly PageFillField[],
  values: Record<string, string>,
): { id: string; selector: string; value: string }[] {
  const ids = new Set(fields.map((field) => field.id));
  if (Object.keys(values).length !== ids.size || Object.keys(values).some((id) => !ids.has(id))) {
    throw new AppError("INVALID_INPUT");
  }
  return fields.map((field) => {
    const value = values[field.id];
    if (typeof value !== "string" || value.length > 2000) throw new AppError("INVALID_INPUT");
    if (field.input === "password" && value.length === 0) throw new AppError("INVALID_INPUT");
    return { id: field.id, selector: field.selector, value };
  });
}

export async function postPageFill(input: {
  origin: string;
  computerId: string;
  agentId: string;
  fields: readonly PageFillField[];
  values: Record<string, string>;
  cookie: string;
  /** Stands in for `fetch`; only the call is needed, not its extras such as `preconnect`. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<{ filled: string[] }> {
  const url = pageFillUrl(input.origin, input.computerId, input.agentId);
  if (!url) throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "page-fill-desktop" });
  const body = pageFillRequestFields(input.fields, input.values);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: input.cookie,
      },
      body: JSON.stringify({ fields: body }),
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "page-fill-desktop" });
  }
  if (response.status === 409) {
    throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "page-fill-browser" });
  }
  if (response.status === 422) {
    throw new AppError("INVALID_INPUT", { errorId: "page-fill-field" });
  }
  if (!response.ok) throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "page-fill-desktop" });
  const filled = body.map((field) => field.id);
  for (const field of body) field.value = "";
  return { filled };
}
