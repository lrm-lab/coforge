import { AgentAttachmentCommentsRequestError } from "#src/connection/agent-attachment-comments-request-error";
import { AgentAppConfigRequestError } from "#src/connection/agent-app-config-request-error";
import { AgentManualRequestError } from "#src/connection/agent-manual-request-error";
import { AgentMentionActionRequestError } from "#src/connection/agent-mention-action-request-error";
import { AgentMentionDeliveryRequestError } from "#src/connection/agent-mention-delivery-request-error";
import { AgentProfileRequestError } from "#src/connection/agent-profile-request-error";
import { AgentUserInfoRequestError } from "#src/connection/agent-user-info-request-error";
type EnvelopeError = Error & {
  errorCode: string;
  status: number;
};
function envelopeFailure(errorClass: abstract new (...args: never[]) => EnvelopeError) {
  return (error: unknown): Response | undefined =>
    error instanceof errorClass
      ? Response.json(
          { ok: false, errorCode: error.errorCode, error: error.message },
          { status: error.status },
        )
      : undefined;
}
export const manualDomainFailure = envelopeFailure(AgentManualRequestError);
export const userInfoDomainFailure = envelopeFailure(AgentUserInfoRequestError);
export const profileDomainFailure = envelopeFailure(AgentProfileRequestError);
export const appConfigDomainFailure = envelopeFailure(AgentAppConfigRequestError);
export const attachmentCommentsDomainFailure = envelopeFailure(AgentAttachmentCommentsRequestError);
export const mentionActionDomainFailure = envelopeFailure(AgentMentionActionRequestError);
export const mentionDeliveryDomainFailure = envelopeFailure(AgentMentionDeliveryRequestError);
