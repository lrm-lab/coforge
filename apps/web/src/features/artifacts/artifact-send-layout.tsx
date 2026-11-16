import type { ShareLayout } from "#src/features/conversations/share-dialog-layout";
import { m } from "#src/paraglide/messages";

export const artifactSendLayout: ShareLayout = {
  modalClassName: "sm:max-w-4xl",
  composerClassName: "sm:border-t-0",
  targetStatus: (count) => (
    <p role="status" className="px-4 text-xs font-medium text-tertiary sm:px-6">
      {m.doc_send_selected({ count })}
    </p>
  ),
  arrives: ({ preview }) => preview,
  arrange: ({ target, composer }) => (
    <div className="flex min-h-0 flex-1 flex-col sm:flex-row sm:border-t sm:border-secondary">
      <div className="flex min-h-24 flex-1 flex-col sm:min-h-[26rem] sm:basis-1/2 sm:pt-4">
        {target}
      </div>
      <div className="flex flex-col sm:basis-1/2 sm:border-l sm:border-secondary">{composer}</div>
    </div>
  ),
};
