import { File02 as FileText } from "@untitledui/icons";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { m } from "#src/paraglide/messages";

/** The Records detail pane before a report or note is picked. */
export function EmptyRecord() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileText aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{m.records_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.records_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
