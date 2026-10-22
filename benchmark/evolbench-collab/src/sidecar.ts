import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import type { SidecarVerdict } from "./enrichment";
import type { AttemptRow } from "./types";

export interface SidecarOutcome {
  verification: AttemptRow["sidecar_verification"] | undefined;
  verdict: SidecarVerdict | undefined;
}

/** Ask the verify sidecar to grade one episode. A sidecar failure never fails the episode. */
export async function verifyWithSidecar(input: {
  sidecarUrl: string | null | undefined;
  /** When set, registered with `POST /env` first so the scorer can read the deliverables. */
  registerWorkspaceDir: string | undefined;
  episodeId: string;
  arm: string;
}): Promise<SidecarOutcome> {
  if (!input.sidecarUrl) return { verification: undefined, verdict: undefined };
  try {
    if (input.registerWorkspaceDir) {
      const registered = await fetch(new URL("/env", input.sidecarUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          episode_id: input.episodeId,
          workspace_dir: input.registerWorkspaceDir,
        }),
      });
      if (!registered.ok) throw new Error(`sidecar /env answered ${registered.status}`);
    }
    const response = await fetch(new URL("/verify", input.sidecarUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ episode_id: input.episodeId }),
    });
    const verdict = (await response.json()) as SidecarVerdict;
    const verification = {
      episode_id: input.episodeId,
      reward: Number(verdict.reward ?? 0),
      graded: Boolean(verdict.graded),
      error: verdict.error ?? null,
    };
    console.log(
      sanitizeDiagnostic(
        `${input.arm} ${input.episodeId} sidecar reward=${verification.reward} graded=${verification.graded}`,
      ),
    );
    return { verification, verdict };
  } catch (error) {
    console.warn(
      sanitizeDiagnostic(`sidecar verify failed for ${input.episodeId}: ${String(error)}`),
    );
    return { verification: undefined, verdict: undefined };
  }
}
