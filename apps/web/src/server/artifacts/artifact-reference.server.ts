import { AppError } from "#src/lib/app-error";
import {
  ARTIFACT_SHORT_ID_PATTERN,
  decodeArtifactShortId,
} from "#src/features/artifacts/artifact-short-id";
import { artifactSandboxOrigin, sandboxTarget } from "./artifact-sandbox-config.server";

export type ArtifactReference = { artifactId: string; version?: number };

type Candidates = (title: string) => Promise<readonly { id: string; title: string }[]>;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_TOKEN = `(?:${UUID}|${ARTIFACT_SHORT_ID_PATTERN})`;
const PAGE_PATH = new RegExp(
  String.raw`(?:(?:/w/[^/\s?#]+)?/artifacts/|/a/)(${ID_TOKEN})(?:[/?#]|$)`,
  "i",
);
const VERSION = /^[1-9]\d{0,8}$/;
const CANDIDATES_NAMED = 5;

const notAReference = (hint: string) =>
  new AppError("INVALID_INPUT", { errorId: "artifact-reference", hint });

function linkReference(link: string): ArtifactReference | null {
  let url: URL;
  try {
    url = new URL(link, "https://link.invalid");
  } catch {
    return null;
  }
  const sandbox = artifactSandboxOrigin();
  const target = sandbox === null ? null : sandboxTarget(new Request(url), sandbox);
  const rawId =
    target?.kind === "artifact"
      ? target.artifactId
      : (PAGE_PATH.exec(url.pathname)?.[1] ?? url.searchParams.get("doc"));
  const artifactId = rawId ? decodeArtifactShortId(rawId) : null;
  if (artifactId === null) return null;
  const version = url.searchParams.get("version") ?? url.searchParams.get("v");
  return {
    artifactId,
    ...(version !== null && VERSION.test(version) ? { version: Number(version) } : {}),
  };
}

export async function resolveArtifactReference(
  reference: string,
  candidates: Candidates,
): Promise<ArtifactReference> {
  const text = reference.trim();
  const directId = decodeArtifactShortId(text);
  if (directId !== null) return { artifactId: directId };
  const link = /^https?:\/\//i.test(text);
  const linked = link || text.startsWith("/") ? linkReference(text) : null;
  if (linked) return linked;
  if (link)
    throw notAReference(
      "that link is not an artifact's: name an artifact by its id, its link or its title",
    );
  const matches = await candidates(text);
  if (matches.length === 0) throw new AppError("NOT_FOUND");
  if (matches.length > 1)
    throw new AppError("CONFLICT", {
      errorId: "artifact-ambiguous-title",
      details: {
        candidates: matches
          .slice(0, CANDIDATES_NAMED)
          .map((match) => match.id)
          .join(","),
      },
      hint: `${matches.length} artifacts you can see are titled "${text}": name one by its id: ${matches
        .slice(0, CANDIDATES_NAMED)
        .map((match) => match.id)
        .join(", ")}`,
    });
  return { artifactId: matches[0]!.id };
}
