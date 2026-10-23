import type { ReactNode } from "react";
import { LinkExternal01, XClose } from "@untitledui/icons";
import { Heading, Link as AriaLink } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { APP_SCOPE_DESCRIPTIONS } from "./app-form";
import { APP_CATEGORY_LABELS } from "./app-list";
import type { AppCategory } from "./app-category";
import { AppLogo } from "./app-logo";
import { appLoginScopes } from "./app-registration";

/** The app's homepage as a link showing its host; the caller says which host (the server computes
 * it for a listing). */
export function HomepageLink({ href, host }: { href: string; host: string }) {
  return (
    <AriaLink
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-fit max-w-full items-center gap-1 rounded-sm text-sm text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <LinkExternal01 aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 font-mono text-xs wrap-anywhere underline underline-offset-4">
        {host}
      </span>
    </AriaLink>
  );
}

/** The Login with CoForge scopes an app may ask for, each with what it releases. */
export function LoginScopeList({ allowedScopes }: { allowedScopes: readonly string[] }) {
  return (
    <ul className="grid gap-1.5">
      {appLoginScopes(allowedScopes).map((scope) => (
        <li key={scope} className="text-sm wrap-anywhere text-secondary">
          <span className="font-mono">{scope}</span>
          <span className="text-tertiary"> · {APP_SCOPE_DESCRIPTIONS[scope]()}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The dialog both app details share: a header with the logo, eyebrow, name, category, `badges`
 * and a close button, a scrolling body, and a footer. `app` is `undefined` while the dialog fades
 * out after its app is gone, and then nothing is drawn.
 */
export function AppDialogShell({
  open,
  onClose,
  eyebrow,
  app,
  badges,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  app: { name: string; logoUrl: string | null; category: AppCategory } | undefined;
  badges?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <ModalOverlay isOpen={open} onOpenChange={(next) => !next && onClose()} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-2xl">
        <Dialog className="flex max-h-[inherit] flex-col overflow-hidden text-left">
          {app && (
            <>
              <div className="flex shrink-0 items-start gap-3 border-b border-secondary px-6 py-4">
                <AppLogo name={app.name} url={app.logoUrl} size="md" />
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="text-xs font-medium text-tertiary">{eyebrow}</p>
                  <Heading
                    slot="title"
                    className="text-lg font-semibold wrap-anywhere text-primary"
                  >
                    {app.name}
                  </Heading>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm text-tertiary">
                      {APP_CATEGORY_LABELS[app.category]()}
                    </span>
                    {badges}
                  </div>
                </div>
                <ButtonUtility
                  type="button"
                  aria-label={m.apps_detail_close()}
                  icon={XClose}
                  size="sm"
                  color="tertiary"
                  onClick={onClose}
                />
              </div>
              <div className="grid min-h-0 flex-1 content-start gap-5 overflow-x-hidden overflow-y-auto px-6 py-5 [&>*]:min-w-0">
                {children}
              </div>
              <div className="flex shrink-0 justify-end gap-3 border-t border-secondary px-6 py-4">
                {footer}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The footer's Close button. */
export function DialogCloseButton({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <Button type="button" size="sm" color="secondary" onPress={onClose}>
      {label}
    </Button>
  );
}
