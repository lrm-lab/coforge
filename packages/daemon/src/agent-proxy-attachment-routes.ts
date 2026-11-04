import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { ATTACHMENT_MAX_BYTES } from "@lrm/coforge-sdk/internal";
import { contentLengthRejected, payloadTooLarge } from "./agent-proxy-body";
import * as domain from "./agent-proxy-domain-failures";
import { exactPath, pathParam } from "./agent-proxy-paths";
import { decodePathParam, parseAttachmentCommentsRequest } from "./agent-proxy-request-parsers";
import { forwardResponse } from "./agent-proxy-response";
import { defineRoute, type ProxyRoute } from "./agent-proxy-route";

/** The local proxy's attachment routes: comments, the file itself, the multipart upload and the
 * presigned direct-upload sessions, in the order the proxy matches them. */

const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
const LOCAL_ATTACHMENT_ROUTE_PREFIX = agentApiRoutes.local.attachments.path("");
const LOCAL_ATTACHMENT_UPLOAD_PATH = agentApiRoutes.local.attachments.upload.path;
// The cloud rejects attachments above `ATTACHMENT_MAX_BYTES`; the local upload hop allows that
// plus slack for multipart framing overhead (boundary markers, field headers), so a file the
// cloud accepts is never refused here. The base number is the SDK's shared fact, not a copy.
const ATTACHMENT_UPLOAD_MAX_BYTES = ATTACHMENT_MAX_BYTES + 64 * 1024;
// The four presigned-direct-upload session routes are plain JSON, so they reuse the
// JSON body path below rather than the multipart forwarding above. `create` is a fixed path;
// `complete`/`cancel`/`get` share a `/:uploadId[/complete]` prefix.
const LOCAL_UPLOAD_SESSION_CREATE_PATH = agentApiRoutes.local.attachmentUploadSessions.create.path;
const LOCAL_UPLOAD_SESSION_ROUTE_PREFIX =
  agentApiRoutes.local.attachmentUploadSessions.get.path("");
const UPLOAD_SESSION_COMPLETE_SUFFIX = "/complete";
const ATTACHMENT_COMMENTS_SUFFIX = "/comments";

export const ATTACHMENT_PROXY_ROUTES: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/attachment-comments",
    method: LOCAL_PROXY_ROUTES.attachmentComments.method,
    // Ahead of the attachment's own route, whose prefix match takes any rest of the path as an id.
    match: pathParam(LOCAL_ATTACHMENT_ROUTE_PREFIX, ATTACHMENT_COMMENTS_SUFFIX),
    body: "none",
    handler: "attachmentComments",
    parse: ({ param, url }) => parseAttachmentCommentsRequest(param, url.searchParams),
    domainFailure: domain.attachmentCommentsDomainFailure,
  }),
  defineRoute({
    family: "agent-api/attachment",
    method: "GET",
    match: pathParam(LOCAL_ATTACHMENT_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachment",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload",
    method: "POST",
    match: exactPath(LOCAL_ATTACHMENT_UPLOAD_PATH),
    body: "none",
    handler: "agentAttachmentUpload",
    parse: ({ request }) =>
      contentLengthRejected(request, ATTACHMENT_UPLOAD_MAX_BYTES, true)
        ? payloadTooLarge()
        : request,
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-create",
    method: "POST",
    match: exactPath(LOCAL_UPLOAD_SESSION_CREATE_PATH),
    body: "json",
    handler: "agentAttachmentUploadSessionCreate",
    parse: ({ payload }) => payload,
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-complete",
    method: "POST",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX, UPLOAD_SESSION_COMPLETE_SUFFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionComplete",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-get",
    method: "GET",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionGet",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-cancel",
    method: "DELETE",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionCancel",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
];
