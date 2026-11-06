import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { formatMonthDayTime } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { cn } from "#src/lib/utils";
import { getLocale } from "#src/paraglide/runtime";
import { MessageAttachments } from "./attachment-card";
import { attachmentMessageDisplayBody } from "./attachment-file-name";
import { useBodyWithArtifactTitles } from "#src/features/artifacts/artifact-card";
import { MessageBody } from "./message-body";
import { groupsWithPrevious, type MessageView } from "./message-view";

/**
 * What a share image shows: the messages as a stream draws them, a sender's run under one heading,
 * and at the foot, quietly, where they come from. It follows the viewer's theme, as the image is
 * what they see. `height` is the least it fills, for an image of a fixed ratio.
 */
export function MessageShareCard({
  messages,
  width,
  height,
}: {
  messages: readonly MessageView[];
  width: number;
  height?: number;
}) {
  return (
    <div
      data-share-page
      className="flex flex-col bg-secondary p-4"
      style={{ width, minHeight: height }}
    >
      <div className="flex flex-1 flex-col rounded-2xl border border-secondary bg-primary">
        <div data-share-rows className="flex-1 px-5 pt-5 pb-1">
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const grouped = groupsWithPrevious(message, previous, false, false).grouped;
            return (
              <ShareRow key={message.id} message={message} grouped={grouped} first={!previous} />
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-4">
          <span className="flex items-center gap-1.5 text-xs font-medium text-tertiary">
            <CoForgeMark className="h-3.5" />
            CoForge
          </span>
          <span className="truncate text-xs text-quaternary">{window.location.host}</span>
        </div>
      </div>
    </div>
  );
}

function ShareRow({
  message,
  grouped,
  first,
}: {
  message: MessageView;
  grouped: boolean;
  first: boolean;
}) {
  const timeFormat = useTimeFormat();
  const body = useBodyWithArtifactTitles(attachmentMessageDisplayBody(message));
  return (
    <div data-share-row className={cn("flex min-w-0 gap-3", !first && (grouped ? "mt-1" : "mt-4"))}>
      <span className="w-8 shrink-0">
        {!grouped && (
          <ActorAvatar
            size="sm"
            presence={false}
            name={message.senderName}
            src={message.senderAvatarUrl}
          />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {!grouped && (
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-primary">
              {message.senderName}
            </span>
            <time className="shrink-0 text-xs text-tertiary tabular-nums">
              {formatMonthDayTime(message.createdAt, null, getLocale(), timeFormat)}
            </time>
          </p>
        )}
        <div className="min-w-0 text-md text-primary [overflow-wrap:anywhere]">
          {body && <MessageBody body={body} mentions={message.mentions} />}
          <MessageAttachments attachments={message.attachments} />
        </div>
      </div>
    </div>
  );
}
