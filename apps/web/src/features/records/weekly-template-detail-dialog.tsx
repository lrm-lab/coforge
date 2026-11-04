import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { ActorName } from "#src/features/avatars/actor-name";
import { m } from "#src/paraglide/messages";
import type { TemplateOutlineSection } from "./template-outline-sections";
import { memberLabel, type TemplateMemberOption } from "./weekly-template-members";

export type WeeklyTemplateDetail = {
  name: string;
  sections: TemplateOutlineSection[];
  allMembers: boolean;
  recipients: Array<{
    userId: string;
    username: string;
    displayName: string | null;
  }>;
  sendTime: string;
  active: boolean;
};

export function WeeklyTemplateDetailDialog({
  template,
  members,
  onClose,
}: {
  template: WeeklyTemplateDetail | null;
  members: TemplateMemberOption[];
  onClose: () => void;
}) {
  if (!template) return null;
  const recipients = template.allMembers
    ? [{ key: "all", name: m.records_template_all_members(), actor: undefined }]
    : template.recipients.map((row) => {
        const member = members.find((item) => item.userId === row.userId);
        const name = memberLabel(member ?? row);
        // A recipient's face before the name (task #521).
        return {
          key: row.userId,
          name,
          actor: {
            kind: "user" as const,
            id: row.userId,
            name,
            avatarUrl: member?.avatarUrl,
          },
        };
      });

  return (
    <ModalOverlay isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal className="w-[calc(100vw-2rem)] max-w-lg">
        <Dialog>
          {({ close }) => (
            <>
              <div className="flex items-start justify-between gap-6 px-6 pt-6">
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {m.records_template_details()}
                </Heading>
                <ButtonUtility
                  aria-label={m.controls_close()}
                  icon={X}
                  size="sm"
                  color="tertiary"
                  onClick={close}
                />
              </div>
              <div className="max-h-[min(70vh,36rem)] space-y-4 overflow-y-auto px-6 py-5 text-sm">
                <DetailRow label={m.records_template_name()} value={template.name} />
                {template.sections.map((section, index) => (
                  <div key={`${section.title}-${index}`} className="space-y-2">
                    <DetailRow
                      label={m.records_template_heading_level_one()}
                      value={section.title}
                    />
                    {section.children.map((child) => (
                      <DetailRow
                        key={child}
                        label={m.records_template_heading_level_two()}
                        value={child}
                        nested
                      />
                    ))}
                  </div>
                ))}
                <div className="flex gap-4">
                  <span className="w-20 shrink-0 text-tertiary">
                    {m.records_template_recipients()}
                  </span>
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    {recipients.map(({ key, name, actor }) => (
                      <Badge key={key} size="sm" color="gray" type="modern">
                        {actor ? <ActorName actor={actor} /> : name}
                      </Badge>
                    ))}
                  </div>
                </div>
                <DetailRow
                  label={m.records_template_frequency()}
                  value={m.records_template_frequency_weekly()}
                />
                <DetailRow label={m.records_template_send_time()} value={template.sendTime} />
                <DetailRow
                  label={m.records_template_enabled()}
                  value={
                    template.active
                      ? m.records_template_enabled_yes()
                      : m.records_template_enabled_no()
                  }
                />
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function DetailRow({
  label,
  value,
  nested = false,
}: {
  label: string;
  value: string;
  nested?: boolean;
}) {
  return (
    <div className={`flex gap-4 ${nested ? "pl-6" : ""}`}>
      <span className="w-20 shrink-0 text-tertiary">{label}</span>
      <span className="min-w-0 text-primary">{value}</span>
    </div>
  );
}
