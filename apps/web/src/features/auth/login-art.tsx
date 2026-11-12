import { useEffect, useRef, useState } from "react";

import { m } from "#src/paraglide/messages";
import { useAttachLoginArt, type LoginWelcome } from "./login-art-state";
import "./login-art.css";

/** The greeting's sway, from the agent's foot: twice to each side, settling. */
const SWAY: Keyframe[] = [
  { transform: "rotate(0deg)" },
  { transform: "rotate(-8deg)", offset: 0.22 },
  { transform: "rotate(7deg)", offset: 0.5 },
  { transform: "rotate(-3deg)", offset: 0.76 },
  { transform: "rotate(0deg)" },
];
const SWAY_MS = 900;
/** The bubble stays up this long after the sway, so it is read before the page goes. */
const HOLD_MS = 200;

/** Leaning back, as if not looking, while a password is typed. */
const LEAN: Keyframe[] = [
  { transform: "rotate(0deg) translateX(0)" },
  { transform: "rotate(-4deg) translateX(-2%)" },
];

/** A sway to each side and back, tilting from its foot, when the pointer comes onto the agent
 * (jing, 11-12: a tilt, not a shake of the head). */
const HOP: Keyframe[] = [
  { transform: "rotate(0deg)" },
  { transform: "rotate(-7deg)", offset: 0.25 },
  { transform: "rotate(6deg)", offset: 0.55 },
  { transform: "rotate(-2.5deg)", offset: 0.8 },
  { transform: "rotate(0deg)" },
];
const HOP_MS = 650;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The brand panel's picture, in the designer's own layers (`public/login/`): the arch with its white
 * door ajar (one still picture), the agent in front and its shadow on the ground. The float and the
 * shadow's breath are `login-art.css`; the pointer coming onto the agent makes it sway side to side
 * once.
 *
 * The agent answers the forms beside it (jing, 11-10; `login-art-state.tsx`): while a password is
 * typed it shuts its eyes and leans away; once signed in it smiles and sways hello with a bubble
 * that says "welcome back", or "welcome aboard" to an account just made. Her two faces, eyes shut
 * and smiling, are layers crossfaded over the open-eyed one.
 */
export function LoginArt() {
  const attach = useAttachLoginArt();
  const root = useRef<HTMLDivElement>(null);
  const agent = useRef<HTMLDivElement>(null);
  const hop = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const [greeting, setGreeting] = useState<LoginWelcome | null>(null);

  useEffect(() => {
    let lean: Animation | null = null;
    attach({
      lookAway(next) {
        setAway(next);
        const el = agent.current;
        if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        if (next && !lean) {
          lean = el.animate(LEAN, {
            duration: 220,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "forwards",
          });
        } else if (!next && lean) {
          const back = lean;
          lean = null;
          back.reverse();
          back.finished.then(() => back.cancel()).catch(() => {});
        }
      },
      async welcome(kind) {
        const el = agent.current;
        // Below `xl` the panel is not shown; there is no one to watch the greeting.
        if (!el || !root.current?.offsetParent) return;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        lean?.cancel();
        lean = null;
        setGreeting(kind);
        const sway = el.animate(SWAY, { duration: SWAY_MS, easing: "ease-in-out" });
        // The provider stops waiting after `WELCOME_LIMIT_MS` whatever happens here.
        await sway.finished.then(() => wait(HOLD_MS)).catch(() => {});
      },
    });
    return () => attach(null);
  }, [attach]);

  // One hop at a time, none during the greeting, none for someone who asked for less motion.
  const onHop = () => {
    const el = hop.current;
    if (!el || greeting !== null || el.getAnimations().length > 0) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(HOP, { duration: HOP_MS, easing: "ease-in-out" });
  };

  // The greeting's smile wins over eyes shut: pressing Enter in the field greets at once.
  const smiling = greeting !== null;
  const shut = away && !smiling;
  return (
    <div ref={root} className="login-art" aria-hidden="true">
      <img src="/login/frame.webp" alt="" className="login-art__frame" />
      <img src="/login/shadow.webp" alt="" className="login-art__shadow" />
      <div ref={agent} className="login-art__agent" onPointerEnter={onHop}>
        <div ref={hop} className="login-art__hop">
          <div className="login-art__float">
            <img src="/login/agent.webp" alt="" className="login-art__face" />
            <img
              src="/login/agent-eyes-shut.webp"
              alt=""
              className="login-art__face login-art__face--over login-art__face--shut"
              data-shown={shut || undefined}
            />
            <img
              src="/login/agent-smile.webp"
              alt=""
              className="login-art__face login-art__face--over login-art__face--smile"
              data-shown={smiling || undefined}
            />
          </div>
        </div>
      </div>
      {greeting ? (
        <div className="login-art__bubble">
          {greeting === "joined" ? m.login_welcome_joined() : m.login_welcome_back()}
        </div>
      ) : null}
    </div>
  );
}
