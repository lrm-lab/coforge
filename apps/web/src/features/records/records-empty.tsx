import { EmptyState } from "#src/components/ui/empty";
import { RecordsWireframe } from "#src/components/ui/empty-wireframes";
import { m } from "#src/paraglide/messages";

export function EmptyRecord() {
  return (
    <EmptyState
      size="page"
      className="h-full"
      picture={<RecordsWireframe />}
      title={m.empty_records_none_selected_title()}
      description={m.empty_records_none_selected_description()}
    />
  );
}
