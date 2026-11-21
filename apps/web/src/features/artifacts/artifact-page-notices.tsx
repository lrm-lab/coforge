import { useCallback, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, SearchLg, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Alert } from "#src/components/ui/alert";
import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/lib/clipboard";
import { cn } from "#src/lib/utils";
import { FLOATING_SURFACE_CLASS } from "#src/features/conversations/review-chrome";
import { m } from "#src/paraglide/messages";

export function usePageErrorReport({
  version,
  error,
  frame,
  dismissError,
}: {
  version: number;
  error: string | null;
  frame: RefObject<HTMLIFrameElement | null>;
  dismissError: () => void;
}) {
  const toast = useAppToast();
  return useCallback(async () => {
    const report = m.doc_page_error_report({
      version,
      width: frame.current?.clientWidth ?? window.innerWidth,
      message: error ?? "",
    });
    if (await copyText(report)) toast.success(m.doc_page_error_copied());
    else toast.error(m.conversation_copy_failed());
    dismissError();
  }, [version, error, frame, toast, dismissError]);
}

export function PageErrorBanner({
  onAskAgent,
  onClose,
  className = "mx-4 mt-3 shrink-0",
}: {
  onAskAgent: () => void;
  onClose: () => void;
  className?: string;
}) {
  return (
    <Alert
      color="error"
      title={m.doc_page_error_title()}
      className={className}
      actions={
        <>
          <Button size="sm" color="secondary" onClick={onAskAgent}>
            {m.doc_page_error_fix()}
          </Button>
          <Button size="sm" color="tertiary" onClick={onClose}>
            {m.doc_page_error_close()}
          </Button>
        </>
      }
    />
  );
}

export function PageExpiredCard({ onReload }: { onReload: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-primary p-6 text-center">
      <p className="text-sm font-medium text-primary">{m.doc_page_expired_title()}</p>
      <p className="text-sm text-secondary">{m.doc_page_expired_body()}</p>
      <Button size="sm" color="secondary" onClick={onReload}>
        {m.doc_page_expired_reload()}
      </Button>
    </div>
  );
}

export function PageFindBar({
  found,
  onFind,
  onClose,
}: {
  found: { total: number; active: number };
  onFind: (query: string, step: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <div
      role="search"
      className={cn(
        "absolute top-3 right-4 z-10 flex items-center gap-1 p-1 outline-focus-ring focus-within:outline-2 focus-within:outline-offset-2",
        FLOATING_SURFACE_CLASS,
      )}
    >
      <label className="flex h-8 w-52 items-center gap-2 pl-2">
        <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
        <input
          aria-label={m.doc_page_find_placeholder()}
          placeholder={m.doc_page_find_placeholder()}
          autoFocus
          value={query}
          className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-hidden placeholder:text-field-placeholder"
          onChange={(event) => {
            setQuery(event.target.value);
            onFind(event.target.value, 0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") onFind(query, event.shiftKey ? -1 : 1);
            if (event.key === "Escape") onClose();
          }}
        />
      </label>
      <span className="min-w-10 text-center text-xs text-tertiary tabular-nums">
        {m.doc_page_find_count({ active: found.active, total: found.total })}
      </span>
      <ButtonUtility
        icon={ChevronUp}
        size="xs"
        color="tertiary"
        tooltip={m.doc_page_find_prev()}
        isDisabled={found.total === 0}
        onClick={() => onFind(query, -1)}
      />
      <ButtonUtility
        icon={ChevronDown}
        size="xs"
        color="tertiary"
        tooltip={m.doc_page_find_next()}
        isDisabled={found.total === 0}
        onClick={() => onFind(query, 1)}
      />
      <ButtonUtility
        icon={XClose}
        size="xs"
        color="tertiary"
        tooltip={m.doc_page_find_close()}
        onClick={onClose}
      />
    </div>
  );
}
