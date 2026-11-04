import type { ComponentType } from "react";
import { XClose } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ArtifactIcon } from "#src/features/artifacts/artifact-parts";
import { LABEL_DOT, LABEL_PALETTE } from "#src/features/tasks/label-colors";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { isWhatsNewId, type WhatsNewId } from "./whats-new-entries";

/** An entry's words and picture; when and to whom it shows is in `whats-new-entries.ts`. */
type WhatsNewContent = {
  title: () => string;
  body: () => string;
  /** A small live scene drawn with the app's own tokens, so it follows light and dark. */
  illustration: ComponentType;
};

function Chip({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-1.5 py-px text-xs font-medium text-secondary ring-1 ring-secondary">
      <span className={cx("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

function LabelsScene() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-3">
      <div className="flex gap-1 overflow-hidden">
        <Chip dot={LABEL_DOT.error!} label="Bug" />
        <Chip dot={LABEL_DOT.pink!} label={m.whats_new_task_labels_demo_design()} />
        <Chip dot={LABEL_DOT.sky!} label={m.whats_new_task_labels_demo_client()} />
      </div>
      <div className="flex justify-between">
        {LABEL_PALETTE.map((color) => (
          <span key={color} className={cx("size-2 rounded-full", LABEL_DOT[color])} />
        ))}
      </div>
    </div>
  );
}

function DocumentsScene() {
  return (
    <div className="flex h-full items-center px-3">
      <div className="flex w-full items-center gap-2 rounded-lg bg-primary p-2 shadow-xs ring-1 ring-secondary">
        <ArtifactIcon size="sm" />
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-primary">
            {m.whats_new_documents_demo_title()}
          </p>
          <p className="truncate text-xs text-tertiary">{m.whats_new_documents_demo_version()}</p>
        </div>
      </div>
    </div>
  );
}

export const WHATS_NEW_CONTENT: Record<WhatsNewId, WhatsNewContent> = {
  documents: {
    title: m.whats_new_documents_title,
    body: m.whats_new_documents_body,
    illustration: DocumentsScene,
  },
  "task-labels": {
    title: m.whats_new_task_labels_title,
    body: m.whats_new_task_labels_body,
    illustration: LabelsScene,
  },
};

interface WhatsNewCardProps {
  id: string;
  /** Entries still waiting after this one. */
  more: number;
  onDismiss: () => void;
}

/** The card above the user card at the bottom of the sidebar (task #493). "Got it" and the close
 * button both mark it seen. On a short window the picture goes, so the navigation above keeps its
 * room. */
export function WhatsNewCard({ id, more, onDismiss }: WhatsNewCardProps) {
  // An id this build does not know (the server is newer) shows nothing.
  if (!isWhatsNewId(id)) return null;
  const entry = WHATS_NEW_CONTENT[id];
  const Illustration = entry.illustration;
  return (
    <section
      aria-label={m.whats_new_label()}
      className="relative mb-2 rounded-xl bg-primary p-3 shadow-xs ring-1 ring-secondary"
    >
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="tertiary"
        aria-label={m.whats_new_close()}
        onClick={onDismiss}
        className="absolute top-2 right-2"
      />
      <span className="inline-flex rounded-full bg-brand-secondary px-1.5 py-px text-xs font-semibold text-brand-secondary">
        {m.whats_new_label()}
      </span>
      <h2 className="mt-1 pr-5 text-sm font-semibold text-primary">{entry.title()}</h2>
      <div
        aria-hidden="true"
        className="mt-2 h-16 overflow-hidden rounded-lg bg-secondary ring-1 ring-secondary [@media(max-height:47.5rem)]:hidden"
      >
        <Illustration />
      </div>
      <p className="mt-2 text-xs text-tertiary">{entry.body()}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" color="secondary" onClick={onDismiss}>
          {m.whats_new_got_it()}
        </Button>
        {more > 0 && (
          <span className="ml-auto text-xs text-quaternary">
            {m.whats_new_more({ count: more })}
          </span>
        )}
      </div>
    </section>
  );
}
