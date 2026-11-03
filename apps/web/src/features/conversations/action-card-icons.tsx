import type { ComponentProps, FC } from "react";
import {
  Edit05,
  Grid01,
  Hash01 as Hash,
  Monitor01 as Monitor,
  Plus,
  ShieldTick,
  UserCheck01,
  UserPlus01 as UserPlus,
} from "@untitledui/icons";

import { mascotStaticUrl } from "#src/features/agents/mascot-contract";
import { cn } from "#src/lib/utils";
import type { ActionCardView } from "#src/server/conversations/action-cards.server";

type Glyph = FC<ComponentProps<"svg">>;

/**
 * `Base` with a small "+" at its corner, as `UserPlus` adds one to a person: the thing a card would
 * make. The badge sits on the card icon's own tile colour, so it reads in both themes.
 */
function withPlus(Base: Glyph): Glyph {
  return function PlusIcon({ className, ...props }) {
    return (
      <span className={cn("relative inline-flex", className)}>
        <Base {...props} className="size-full" />
        <span className="absolute -right-1.5 -bottom-1.5 flex size-3 items-center justify-center rounded-full bg-tertiary">
          <Plus aria-hidden="true" className="size-2.5" strokeWidth={3} />
        </span>
      </span>
    );
  };
}

/**
 * A new Agent: a mascot, as every Agent shows itself, with a "+". The mascot is in colour, so its
 * "+" is a solid brand disc rather than the line icons' grey one, to read in both themes.
 */
function AgentPlus({ className }: ComponentProps<"svg">) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <img src={mascotStaticUrl("purple")} alt="" className="size-full scale-125" />
      <span className="absolute -right-1.5 -bottom-1.5 flex size-3 items-center justify-center rounded-full bg-brand-solid text-white ring-2 ring-bg-tertiary">
        <Plus aria-hidden="true" className="size-2.5" strokeWidth={3.5} />
      </span>
    </span>
  );
}
/** A new app: the grid the app settings and an Agent's Apps tab show apps by. */
const AppPlus = withPlus(Grid01);

/** Icon for the card header by kind (task #449; Frank picked from candidates in light and dark). */
export function actionCardIcon(kind: ActionCardView["kind"]): Glyph {
  switch (kind) {
    case "channel:create":
      return Hash;
    case "agent:create":
      return AgentPlus;
    case "desktop:takeover":
      return Monitor;
    case "page:fill":
      return Edit05;
    case "app:grant_agent":
      return ShieldTick;
    case "app:register":
      return AppPlus;
    case "app:recover_owner":
      return UserCheck01;
    default:
      return UserPlus;
  }
}
