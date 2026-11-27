import {
  Activity,
  ChevronRight,
  MessageChatSquare,
  MessageTextSquare01,
  Monitor01,
  Phone01,
  Settings01,
} from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import "./whats-new-feedback-scene.css";

function UserInitial({ label, rounded = false }: { label: string; rounded?: boolean }) {
  const initial = Array.from(label.trim())[0] ?? "A";
  return (
    <span
      className={
        rounded
          ? "inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-tertiary text-xs leading-none font-semibold text-secondary ring-1 ring-secondary sm:size-7"
          : "inline-flex size-4.5 shrink-0 items-center justify-center rounded-md bg-tertiary text-xs leading-none font-semibold text-secondary ring-1 ring-secondary sm:size-5"
      }
    >
      {initial}
    </span>
  );
}

export function FeedbackScene() {
  const userName = m.whats_new_feedback_demo_user();

  return (
    <div className="flex h-full w-full items-center justify-center bg-secondary px-3 pt-6 pb-4 select-none sm:px-8 sm:py-6">
      <div className="grid w-full max-w-[35rem] grid-cols-2 items-end gap-2.5 sm:grid-cols-[1.15fr_1fr] sm:items-center sm:gap-5">
        <div className="wnf-desktop-card flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-tertiary">
            <Monitor01 aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
            <span className="truncate">{m.whats_new_feedback_demo_desktop()}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl bg-sidebar p-2 shadow-sm ring-1 ring-secondary sm:p-2.5">
            <div className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-tertiary">
              <MessageChatSquare
                aria-hidden="true"
                className="size-3.5 shrink-0 text-fg-quaternary"
              />
              <span className="min-w-0 truncate">{m.navigation_chat()}</span>
            </div>
            <div className="hidden items-center gap-2 rounded-md px-2 py-1 text-xs text-tertiary sm:flex">
              <Activity aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
              <span className="min-w-0 truncate">{m.navigation_activity()}</span>
            </div>
            <div className="my-0.5 border-t border-secondary sm:my-1" />
            <div className="wnf-highlight flex items-center gap-2 rounded-lg bg-primary px-2 py-1.5 shadow-xs ring-1 ring-primary sm:px-2.5 sm:py-2">
              <MessageTextSquare01
                aria-hidden="true"
                className="size-3.5 shrink-0 text-primary sm:size-4"
              />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-primary">
                {m.feedback_entry()}
              </span>
              <span className="size-1.5 shrink-0 rounded-full bg-fg-secondary" />
            </div>
            <div className="flex items-center gap-2 rounded-md px-2 py-1 sm:px-2.5 sm:py-1.5">
              <UserInitial label={userName} />
              <span className="min-w-0 truncate text-xs text-tertiary">{userName}</span>
            </div>
          </div>
        </div>

        <div className="wnf-mobile-card flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-tertiary">
            <Phone01 aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
            <span className="truncate">{m.whats_new_feedback_demo_mobile()}</span>
          </div>
          <div className="flex flex-col rounded-xl bg-primary p-2 shadow-sm ring-1 ring-secondary sm:p-2.5">
            <div className="border-b border-secondary pb-1 text-center text-xs font-semibold text-secondary">
              {m.navigation_me()}
            </div>
            <div className="flex flex-col items-center gap-1 py-2 sm:py-2.5">
              <UserInitial label={userName} rounded />
              <span className="max-w-full truncate text-xs font-medium text-primary">
                {userName}
              </span>
            </div>
            <div className="wnf-highlight flex items-center gap-1.5 rounded-lg border border-primary bg-secondary px-2 py-1.5 shadow-xs sm:gap-2 sm:px-2.5 sm:py-2">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-primary ring-1 ring-secondary sm:size-6">
                <MessageTextSquare01
                  aria-hidden="true"
                  className="size-3 text-primary sm:size-3.5"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-primary">
                  {m.feedback_entry()}
                </span>
                <span className="hidden text-xs leading-snug text-tertiary sm:line-clamp-2">
                  {m.feedback_entry_subtitle()}
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-fg-quaternary rtl:rotate-180"
              />
            </div>
            <div className="mt-2 hidden items-center gap-2 border-t border-secondary px-1 pt-2 text-xs text-tertiary sm:flex">
              <Settings01 aria-hidden="true" className="size-3.5 shrink-0 text-fg-quaternary" />
              <span className="min-w-0 truncate">{m.navigation_personal_settings()}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
