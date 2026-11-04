import type { ComponentType, ReactNode } from "react";
import { LABEL_DOT, LABEL_PALETTE } from "#src/features/tasks/label-colors";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import type { WhatsNewId } from "./whats-new-entries";

/** An entry's words and picture; when and to whom it shows is in `whats-new-entries.ts`. */
type WhatsNewContent = {
  title: () => string;
  body: () => string;
  /** A live scene drawn with the app's own tokens, so it follows light and dark. */
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

function TaskRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-primary px-3 py-2.5 shadow-xs ring-1 ring-secondary">
      <p className="flex items-center gap-2 truncate text-sm font-medium text-primary">
        <span className="size-3.5 shrink-0 rounded-full ring-[1.5px] ring-fg-quaternary ring-inset" />
        {title}
      </p>
      <div className="mt-2 flex gap-1 pl-5.5">{children}</div>
    </div>
  );
}

function LabelsScene() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-6 sm:px-12">
      <TaskRow title={m.whats_new_task_labels_demo_task()}>
        <Chip dot={LABEL_DOT.error!} label="Bug" />
        <Chip dot={LABEL_DOT.pink!} label={m.whats_new_task_labels_demo_design()} />
      </TaskRow>
      <TaskRow title={m.whats_new_task_labels_demo_task_2()}>
        <Chip dot={LABEL_DOT.sky!} label={m.whats_new_task_labels_demo_client()} />
      </TaskRow>
      <div className="mt-1 flex justify-between px-1">
        {LABEL_PALETTE.map((color) => (
          <span key={color} className={cx("size-2.5 rounded-full", LABEL_DOT[color])} />
        ))}
      </div>
    </div>
  );
}

export const WHATS_NEW_CONTENT: Record<WhatsNewId, WhatsNewContent> = {
  "task-labels": {
    title: m.whats_new_task_labels_title,
    body: m.whats_new_task_labels_body,
    illustration: LabelsScene,
  },
};
