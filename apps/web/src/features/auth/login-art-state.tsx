import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

/** How the sign-in finished: an account that had signed in before, or one just made. */
export type LoginWelcome = "back" | "joined";

/**
 * What the sign-in forms can ask of the brand panel's agent (jing, 11-10): to look away while a
 * password is typed, and to greet the person once they are in. `welcome` settles when the greeting
 * has played, at once when the agent is not on screen or the person asked for less motion, so a
 * form can wait for it before leaving the page.
 */
export type LoginArtControls = {
  lookAway(away: boolean): void;
  welcome(kind: LoginWelcome): Promise<void>;
};

const STILL: LoginArtControls = { lookAway: () => {}, welcome: async () => {} };

const Context = createContext<{
  controls: LoginArtControls;
  attach: (art: LoginArtControls | null) => void;
}>({ controls: STILL, attach: () => {} });

/** Joins the forms to the agent they sit beside. Without one (the reset page) the forms ask
 * nothing of anyone. */
export function LoginArtProvider({ children }: { children: ReactNode }) {
  const art = useRef<LoginArtControls | null>(null);
  const value = useMemo(
    () => ({
      controls: {
        lookAway: (away: boolean) => (art.current ?? STILL).lookAway(away),
        welcome: (kind: LoginWelcome) => (art.current ?? STILL).welcome(kind),
      },
      attach: (next: LoginArtControls | null) => {
        art.current = next;
      },
    }),
    [],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** For a sign-in form: the agent beside it. */
export function useLoginArt(): LoginArtControls {
  return useContext(Context).controls;
}

/** For the agent: hands its controls to the forms. */
export function useAttachLoginArt() {
  return useContext(Context).attach;
}
