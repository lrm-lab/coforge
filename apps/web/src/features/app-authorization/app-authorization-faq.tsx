import { ChevronRight } from "@untitledui/icons";
import { Button as AriaButton, Disclosure, DisclosurePanel } from "react-aria-components";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/** The questions beside the consent: what Login with CoForge is, how an app gets registered, and
 * why an Agent does not sign in here. Each answer opens on demand. */
export function AuthorizationFaq() {
  const entries = [
    [m.app_authorization_faq_what_title(), m.app_authorization_faq_what_body()],
    [m.app_authorization_faq_register_title(), m.app_authorization_faq_register_body()],
    [m.app_authorization_faq_agent_title(), m.app_authorization_faq_agent_body()],
  ] as const;
  return (
    <>
      <h2 className="mb-3 text-lg font-semibold text-primary">{m.app_authorization_faq_title()}</h2>
      <div className="flex flex-col gap-1">
        {entries.map(([question, answer]) => (
          <Disclosure key={question}>
            {({ isExpanded }) => (
              <>
                <AriaButton
                  slot="trigger"
                  className="flex w-full cursor-pointer items-start gap-1.5 rounded-lg py-2 text-left text-sm font-semibold text-primary outline-focus-ring focus-visible:outline-2"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 size-4 shrink-0 text-fg-quaternary transition-transform motion-reduce:transition-none",
                      isExpanded && "rotate-90",
                    )}
                  />
                  {question}
                </AriaButton>
                <DisclosurePanel
                  // A collapsed panel is `hidden="until-found"`, which Tailwind's preflight leaves
                  // displayed: hide it outright.
                  className={cn("pb-2 pl-5.5 text-sm text-tertiary", !isExpanded && "hidden")}
                >
                  {answer}
                </DisclosurePanel>
              </>
            )}
          </Disclosure>
        ))}
      </div>
    </>
  );
}
