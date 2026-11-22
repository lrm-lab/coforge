import { ChevronLeft, ChevronRight } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { formatNumber } from "#src/lib/format-number";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

export const RECORDS_MEMBERS_PAGE_SIZE = 20;

export function paginateRecordsMembers<T>(
  items: readonly T[],
  page: number,
  pageSize = RECORDS_MEMBERS_PAGE_SIZE,
) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = safePage * pageSize;
  return {
    total,
    totalPages,
    safePage,
    startIndex,
    visible: items.slice(startIndex, startIndex + pageSize),
  };
}

export function RecordsMemberPagination({
  total,
  pageSize = RECORDS_MEMBERS_PAGE_SIZE,
  safePage,
  totalPages,
  startIndex,
  onPageChange,
  className,
}: {
  total: number;
  pageSize?: number;
  safePage: number;
  totalPages: number;
  startIndex: number;
  onPageChange: (nextPage: number) => void;
  className?: string;
}) {
  if (total <= pageSize) return null;
  const status = m.records_page_status({
    start: formatNumber(startIndex + 1),
    end: formatNumber(Math.min(total, startIndex + pageSize)),
    total: formatNumber(total),
  });
  return (
    <nav
      aria-label={status}
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-secondary",
        className,
      )}
    >
      <span className="text-xs text-tertiary tabular-nums">{status}</span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          color="secondary"
          iconLeading={ChevronLeft}
          className="*:data-icon:rtl:rotate-180"
          isDisabled={safePage === 0}
          onPress={() => onPageChange(Math.max(0, safePage - 1))}
        >
          {m.records_report_present_prev()}
        </Button>
        <Button
          size="sm"
          color="secondary"
          iconTrailing={ChevronRight}
          className="*:data-icon:rtl:rotate-180"
          isDisabled={safePage >= totalPages - 1}
          onPress={() => onPageChange(Math.min(totalPages - 1, safePage + 1))}
        >
          {m.records_report_present_next()}
        </Button>
      </div>
    </nav>
  );
}
