/**
 * An app's Agent manifest: a public JSON document, written by the app's publisher, that tells an
 * Agent how to use the app once it has a token. CoForge never runs anything from it and never
 * fetches it; it hands the location on to the Agent, which reads it as data. Pure and client-safe.
 */

/** Where an app's manifest is looked for when it names none: this path on its homepage's origin. */
export const AGENT_MANIFEST_WELL_KNOWN_PATH = "/.well-known/coforge-agent-manifest.json";

/** Whether the location was typed by the publisher (`explicit`) or derived from the homepage. */
export type AgentManifestSource = "explicit" | "well_known";

/** The manifest location an Agent is told, and where it came from; both `null` for an app that
 * names none and has no homepage to derive one from. */
export type AgentManifestLocation = {
  agentManifestUrl: string | null;
  agentManifestUrlSource: AgentManifestSource | null;
};

/**
 * The explicit location when the app set one (used as written, whatever its path), else the
 * well-known path on the homepage's origin, else none. A derived location may not exist: a missing
 * manifest is not an error, only an app that has nothing to say to an Agent.
 */
export function resolveAgentManifest(app: {
  agentManifestUrl: string | null;
  homepageUrl: string | null;
}): AgentManifestLocation {
  if (app.agentManifestUrl)
    return { agentManifestUrl: app.agentManifestUrl, agentManifestUrlSource: "explicit" };
  if (!app.homepageUrl) return { agentManifestUrl: null, agentManifestUrlSource: null };
  return {
    agentManifestUrl: new URL(AGENT_MANIFEST_WELL_KNOWN_PATH, app.homepageUrl).href,
    agentManifestUrlSource: "well_known",
  };
}
