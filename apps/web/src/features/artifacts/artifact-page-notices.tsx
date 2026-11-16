import { useState } from "react";
import { ChevronDown, ChevronUp, SearchLg, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";

export function PageErrorBanner({
  onAskAgent,
  onClose,
}: {
  onAskAgent: () => void;
  onClose: () => void;
}) {
  return (
    <Alert
      color="error"
      title={m.doc_page_error_title()}
      className="mx-4 mt-3 shrink-0"
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
      <p className="text-sm font-semibold text-primary">{m.doc_page_expired_title()}</p>
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
      className="absolute top-3 right-4 z-10 flex items-center gap-1 rounded-xl border border-secondary bg-primary p-1.5 shadow-lg"
    >
      <Input
        aria-label={m.doc_page_find_placeholder()}
        placeholder={m.doc_page_find_placeholder()}
        icon={SearchLg}
        size="sm"
        autoFocus
        value={query}
        onChange={(next) => {
          setQuery(next);
          onFind(next, 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") onFind(query, event.shiftKey ? -1 : 1);
          if (event.key === "Escape") onClose();
        }}
        wrapperClassName="w-52"
      />
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
