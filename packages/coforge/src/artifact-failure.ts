import { CliError } from "#src/cli-error";
import { readProxyErrorBody } from "#src/proxy-request";

/** What the CLI says when the Workspace has not switched artifacts on: the refusal names the
 * switch and the working alternative, so an Agent that tried `artifact` learns to send the file
 * as an attachment instead of retrying or claiming a send that never happened (task #711). */
export const ARTIFACTS_DISABLED_MESSAGE =
  "这个工作区没有开启 artifacts：`coforge artifact` 命令不能用。要给人发文件，请用附件：先 `coforge attachment upload --path <文件> --target <会话>` 拿到附件 id，再 `coforge message send --target <会话> --attachment-id <id>` 发出（工作区 owner/admin 可在 设置 → 实验功能 打开 artifacts）。This Workspace has not enabled artifacts, so `coforge artifact` commands cannot be used. To send a file to a person, upload it as an attachment (`coforge attachment upload --path <file> --target <target>`), then send its id (`coforge message send --target <target> --attachment-id <id>`); a Workspace owner or admin can enable artifacts in Settings > Experiments.";

/** What a failed artifact call to the daemon's proxy is told apart by. */
export type ArtifactCall = {
  /** Names the call in a message: `artifact push`, `artifact file upload`. */
  label: string;
  /** Changes something and is not replayed when run again: a failure on the way may still have
   * landed. Reads, and uploads and downloads of bytes by hash, are safe to run again. */
  writes: boolean;
  /** The next step after a failure of a write that may have landed. */
  mayHaveLanded?: string;
  /** The next step when the artifact has a newer version than the call's base. */
  baseMoved?: string;
  /** A bare 404 from the proxy means the file is not there. */
  missingIs404?: boolean;
};

/** The call never got an answer: the network failed or the time ran out. */
export function artifactNetworkFailure(message: string, call: ArtifactCall): CliError {
  return new CliError({
    code: "ARTIFACT_FAILED",
    message,
    retryable: !call.writes,
    ...(call.writes && call.mayHaveLanded ? { suggestedNextAction: call.mayHaveLanded } : {}),
  });
}

/** The proxy's refusal of an artifact call, as the error the Agent reads. */
export async function artifactRefusal(response: Response, call: ArtifactCall): Promise<CliError> {
  const { json } = await readProxyErrorBody(response);
  const message = json?.error ?? `HTTP ${response.status}`;
  if (message.includes("(artifacts-disabled)"))
    return new CliError({
      code: "ARTIFACTS_DISABLED",
      message: ARTIFACTS_DISABLED_MESSAGE,
      retryable: false,
    });
  const notFound = json?.code === "NOT_FOUND";
  // The server's own hint (a version without that file) says more than the general one.
  const next = notFound
    ? (json?.suggested_next_action ??
      "The artifact or conversation does not exist, or you cannot read it.")
    : message.includes("(artifact-base-moved)") && call.baseMoved
      ? call.baseMoved
      : call.writes && response.status >= 500
        ? call.mayHaveLanded
        : json?.suggested_next_action;
  return new CliError({
    code:
      json?.code ??
      (call.missingIs404 && response.status === 404 ? "NOT_FOUND" : "ARTIFACT_FAILED"),
    message: `${call.label} failed: ${message}`,
    // A read is safe to run again; a missing `retryable` leaves it to the failure, as the
    // proxy's contract says: a 5xx is worth another try.
    retryable: !call.writes && (json?.retryable ?? response.status >= 500),
    ...(next ? { suggestedNextAction: next } : {}),
    ...(json?.proxy?.correlation_id ? { correlationId: json.proxy.correlation_id } : {}),
    // Facts the server names for a refusal, such as the files an Agent save clashed on.
    ...(json?.details ? { details: json.details } : {}),
  });
}
