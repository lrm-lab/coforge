import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Heading } from "react-aria-components";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LinkExternal01, XClose } from "@untitledui/icons";
import {
  RUNTIME_AUTH_INFO_ANTIGRAVITY_BROWSER_LOGIN,
  type KiroLoginTarget,
  type RuntimeAuthProvider,
} from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { Spinner } from "#src/components/ui/spinner";
import { m } from "#src/paraglide/messages";
import {
  cancelRuntimeAuthLogin,
  readRuntimeAuthKiroFree,
  readRuntimeAuthLogin,
  startRuntimeAuthLogin,
} from "./runtime-auth.functions";
import {
  initialLoginState,
  loginReducer,
  retryable,
  safeSignInUrl,
  type LoginFailure,
  type LoginState,
  type LoginView,
} from "./runtime-auth-login-state";
import { AntigravitySignIn } from "#src/features/computers/antigravity-sign-in";
import { KiroEnterpriseSignIn } from "./kiro-enterprise-sign-in";
import { CodeForm, DeviceCode } from "./runtime-sign-in-code";
import { useRuntimeAuthSignals } from "./use-runtime-auth-signals";

type Target = {
  computerId: string;
  computerName: string;
  provider: RuntimeAuthProvider;
  runtimeName: string;
};

/** At most this many views wait for the login id the start returns; a login sends far fewer. */
const EARLY_VIEW_LIMIT = 16;
/** The start call's own bound: past it the server is not answering, whatever it may still do. */
const SIGN_IN_START_TIMEOUT_MS = 120_000;
/** A started login with no report by now never reached its runtime (the server's own window). */
const SIGN_IN_SILENT_TIMEOUT_MS = 10 * 60_000;
/** Past every adapter's deadline and the record's lifetime: the last resort, never reached healthy. */
const SIGN_IN_HARD_TIMEOUT_MS = 20 * 60_000;
/** A running login re-reads its record this often; signals are best effort, reads are not. */
const SIGN_IN_CATCHUP_INTERVAL_MS = 30_000;

/**
 * Signs a Computer's runtime in from the web, as on Raft: the dialog shows what the runtime's own
 * flow asks for (a page to open, a device code, a code to paste back) until it ends. The code and
 * the link live only in this dialog's state; closing it drops them and cancels a running login.
 */
export function RuntimeSignInDialog({ onClose, ...target }: Target & { onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [kiro, setKiro] = useState<KiroLoginTarget>();
  const [antigravityMethodId, setAntigravityMethodId] = useState<
    "oauth-personal" | "oauth-business"
  >();
  const closeAction = useRef<(() => void) | undefined>(undefined);
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) {
          if (closeAction.current) closeAction.current();
          else onClose();
        }
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left">
          {target.provider === RUNTIME_PROVIDER.KIRO && !kiro ? (
            <KiroChoice computerId={target.computerId} onStart={setKiro} onClose={onClose} />
          ) : target.provider === RUNTIME_PROVIDER.ANTIGRAVITY && !antigravityMethodId ? (
            <AntigravitySignIn onStart={setAntigravityMethodId} onClose={onClose} />
          ) : (
            <SignInAttempt
              key={attempt}
              {...target}
              kiro={kiro}
              antigravityMethodId={antigravityMethodId}
              closeAction={closeAction}
              onRetry={() => {
                setAttempt((n) => n + 1);
                setKiro(undefined);
              }}
              onClose={onClose}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * Kiro's first step: the choice of a free or an enterprise account where the Computer can sign in
 * free (task #87), else the enterprise form as it always was. A failed read counts as "cannot".
 */
function KiroChoice({
  computerId,
  onStart,
  onClose,
}: {
  computerId: string;
  onStart: (target: KiroLoginTarget) => void;
  onClose: () => void;
}) {
  const read = useServerFn(readRuntimeAuthKiroFree);
  const offerFree = useQuery({
    queryKey: ["runtime-auth-kiro-free", computerId],
    queryFn: () => read({ data: { computerId } }),
    retry: false,
  });
  if (offerFree.isPending)
    return (
      <div className="flex min-h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  return (
    <KiroEnterpriseSignIn offerFree={offerFree.data === true} onStart={onStart} onClose={onClose} />
  );
}

function SignInAttempt({
  computerId,
  computerName,
  provider,
  runtimeName,
  kiro,
  antigravityMethodId,
  closeAction,
  onRetry,
  onClose,
}: Target & {
  kiro?: KiroLoginTarget;
  antigravityMethodId?: "oauth-personal" | "oauth-business";
  closeAction: RefObject<(() => void) | undefined>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(loginReducer, initialLoginState);
  const start = useServerFn(startRuntimeAuthLogin);
  const read = useServerFn(readRuntimeAuthLogin);
  const cancel = useServerFn(cancelRuntimeAuthLogin);
  const loginId = useRef<string | undefined>(undefined);
  const subscribed = useRef(false);
  const closed = useRef(false);
  const early = useRef<LoginView[]>([]);
  const began = useRef(false);
  const attached = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const gaveUp = useRef(false);
  useEffect(() => {
    attached.current = true;
    return () => {
      attached.current = false;
      // StrictMode reattaches before this microtask; a real navigation leaves it detached.
      queueMicrotask(() => {
        if (attached.current || closed.current) return;
        closed.current = true;
        if (loginId.current)
          void cancel({ data: { computerId, loginId: loginId.current } }).catch(() => {});
      });
    };
  }, []);

  // Subscribe, then read: the read covers what the channel delivered before this page knew the
  // login, and the reducer drops whatever both deliver.
  const catchUp = () => {
    const id = loginId.current;
    if (!id || !subscribed.current) return;
    void read({ data: { computerId, loginId: id } })
      .then((view) => view && dispatch({ type: "view", view, now: Date.now() }))
      .catch(() => {});
  };
  useRuntimeAuthSignals(computerId, {
    onSubscribed: () => {
      subscribed.current = true;
      catchUp();
    },
    onSignal: (signal) => {
      if (signal.type !== REALTIME_EVENTS.runtimeAuthLogin || signal.provider !== provider) return;
      if (loginId.current) dispatch({ type: "view", view: signal, now: Date.now() });
      else if (early.current.length < EARLY_VIEW_LIMIT) early.current.push(signal);
    },
  });

  useEffect(() => {
    // Once per attempt, on a guard rather than cleanup: StrictMode's second run must not start a
    // second login, and only closing the dialog cancels one.
    if (began.current) return;
    began.current = true;
    start({
      data: {
        computerId,
        provider,
        ...(kiro?.license === "pro" ? { kiroIdentityCenter: kiro.identityCenter } : {}),
        ...(kiro ? { kiroLicense: kiro.license } : {}),
        ...(antigravityMethodId ? { antigravityMethodId } : {}),
      },
    })
      .then((started) => {
        // A deadline already ended the attempt: a login that arrives this late is cancelled
        // unseen rather than left holding the runtime's sign-in slot.
        if (gaveUp.current) {
          if (started.status === "started")
            void cancel({ data: { computerId, loginId: started.loginId } }).catch(() => {});
          return;
        }
        if (started.status !== "started") {
          dispatch({ type: "start_refused", status: started.status });
          return;
        }
        loginId.current = started.loginId;
        if (closed.current) {
          void cancel({ data: { computerId, loginId: started.loginId } }).catch(() => {});
          return;
        }
        dispatch({ type: "started", loginId: started.loginId });
        for (const view of early.current) dispatch({ type: "view", view, now: Date.now() });
        early.current = [];
        catchUp();
      })
      .catch(() => dispatch({ type: "start_failed" }));
  }, []);

  // The dialog never waits forever: an unanswered start, a login that never reported, and any
  // login past every adapter's own deadline each end in the timed_out the server would send.
  useEffect(() => {
    const end = () => {
      const current = stateRef.current;
      if (current.phase !== "starting" && current.phase !== "running") return;
      gaveUp.current = true;
      if (current.phase === "running" && loginId.current)
        void cancel({ data: { computerId, loginId: loginId.current } }).catch(() => {});
      dispatch({ type: "timed_out" });
    };
    const timers = [
      setTimeout(() => {
        if (stateRef.current.phase === "starting") end();
      }, SIGN_IN_START_TIMEOUT_MS),
      setTimeout(() => {
        const current = stateRef.current;
        // `sequence` stays under 1 until the daemon's first report; a bare record read is not one.
        if (current.phase === "running" && current.sequence < 1) end();
      }, SIGN_IN_SILENT_TIMEOUT_MS),
      setTimeout(end, SIGN_IN_HARD_TIMEOUT_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (state.phase !== "running") return;
    const id = setInterval(catchUp, SIGN_IN_CATCHUP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.phase]);

  const running = state.phase === "starting" || state.phase === "running";
  const close = () => {
    closed.current = true;
    if (running && loginId.current)
      void cancel({ data: { computerId, loginId: loginId.current } }).catch(() => {});
    onClose();
  };

  useLayoutEffect(() => {
    closeAction.current = close;
    return () => {
      closeAction.current = undefined;
    };
  });

  return (
    <>
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <Heading slot="title" className="min-w-0 text-lg font-semibold text-primary">
          {m.runtime_auth_sign_in_title({ runtime: runtimeName })}
        </Heading>
        <ButtonUtility
          aria-label={m.controls_close()}
          icon={XClose}
          size="sm"
          color="tertiary"
          onClick={close}
        />
      </div>
      <div className="space-y-4 px-6 pt-4 text-sm text-secondary">
        <SignInBody
          state={state}
          computerId={computerId}
          computerName={computerName}
          runtimeName={runtimeName}
          dispatch={dispatch}
        />
      </div>
      <DialogActions className="px-6 pt-6 pb-6">
        {state.phase === "signed_in" ? (
          <DialogAction onPress={close}>{m.runtime_auth_done()}</DialogAction>
        ) : (
          <>
            <DialogCancel onPress={close}>
              {running ? m.controls_cancel() : m.controls_close()}
            </DialogCancel>
            {state.phase === "failed" && retryable(state.failure) && (
              <DialogAction onPress={onRetry}>{m.runtime_auth_try_again()}</DialogAction>
            )}
          </>
        )}
      </DialogActions>
    </>
  );
}

function SignInBody({
  state,
  computerId,
  computerName,
  runtimeName,
  dispatch,
}: {
  state: LoginState;
  computerId: string;
  computerName: string;
  runtimeName: string;
  dispatch: (action: Parameters<typeof loginReducer>[1]) => void;
}): ReactNode {
  switch (state.phase) {
    case "starting":
      return <Waiting>{m.runtime_auth_starting({ computer: computerName })}</Waiting>;
    case "signed_in": {
      const account = [state.account?.maskedLabel, state.account?.planLabel].filter(Boolean);
      return (
        <div role="status">
          <p className="text-primary">
            {m.runtime_auth_signed_in({ runtime: runtimeName, computer: computerName })}
          </p>
          {account.length > 0 && <p className="text-tertiary">{account.join(" · ")}</p>}
        </div>
      );
    }
    case "failed":
      return (
        <p role="alert" className="text-error-primary">
          {failureText(state.failure, runtimeName)}
        </p>
      );
    case "running":
      return (
        <>
          {state.link?.kind === "auth_url" && <AuthPage url={state.link.url} />}
          {state.link?.kind === "device_code" && (
            <DeviceCode event={state.link} expiresAtMs={state.expiresAtMs} />
          )}
          {state.info && <p className="text-tertiary">{signInInfo(state.info)}</p>}
          {state.prompt !== undefined && !state.checking && (
            <CodeForm
              computerId={computerId}
              loginId={state.loginId}
              rejected={state.rejected}
              dispatch={dispatch}
            />
          )}
          {state.checking && <Waiting>{m.runtime_auth_checking()}</Waiting>}
          {/* Waiting on the browser, not on the person: a code to paste back means the next
              step is theirs, so no spinner then. */}
          {state.link && state.prompt === undefined && !state.checking && (
            <Waiting>{m.runtime_auth_waiting()}</Waiting>
          )}
          {!state.link && !state.info && state.prompt === undefined && (
            <Waiting>{m.runtime_auth_starting({ computer: computerName })}</Waiting>
          )}
        </>
      );
  }
}

/** An `info` event either carries a token this page words itself or a runtime's own sentence. */
function signInInfo(message: string): string {
  if (message === RUNTIME_AUTH_INFO_ANTIGRAVITY_BROWSER_LOGIN)
    return m.runtime_auth_antigravity_hint();
  return message;
}

/** A step that waits on something outside the dialog: one small spinner before its line. */
function Waiting({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-tertiary">
      <Spinner className="size-4 shrink-0" />
      {children}
    </p>
  );
}

/** One sentence for every runtime, as on Raft: the runtime's own instructions are not shown. */
function AuthPage({ url }: { url: string }) {
  const safe = safeSignInUrl(url);
  const controlSize = useDialogControlSize();
  return (
    <>
      <p>{m.runtime_auth_open_page_hint()}</p>
      <Button
        size={controlSize}
        iconTrailing={LinkExternal01}
        isDisabled={!safe}
        onPress={() => safe && window.open(safe, "_blank", "noopener,noreferrer")}
      >
        {m.runtime_auth_open_page()}
      </Button>
    </>
  );
}

function failureText(failure: LoginFailure, runtime: string): string {
  switch (failure.kind) {
    case "offline":
      return m.runtime_auth_failed_offline();
    case "needs_upgrade":
      return m.runtime_auth_failed_needs_upgrade();
    case "busy":
      return m.runtime_auth_failed_busy();
    case "start_failed":
      return m.runtime_auth_failed_start();
    case "cancelled":
      return m.runtime_auth_failed_cancelled();
    case "ended":
      return m.runtime_auth_failed_ended();
    case "unsupported":
      return unsupportedText(failure.reason, runtime);
    case "failed":
      if (failure.detail === "kiro_device_flow_disabled")
        return m.runtime_auth_kiro_device_disabled();
      if (failure.detail === "kiro_external_idp_unsupported")
        return m.runtime_auth_kiro_external_idp();
      if (failure.detail === "codex_login_start_failed")
        return m.runtime_auth_codex_start_failed({ runtime });
      if (failure.detail === "antigravity_no_desktop")
        return m.runtime_auth_antigravity_no_desktop();
      if (failure.detail === "droid_code_unavailable")
        return m.runtime_auth_droid_code_unavailable();
      switch (failure.reason) {
        case "timed_out":
          return m.runtime_auth_failed_timed_out();
        case "rejected":
          return m.runtime_auth_failed_rejected({ runtime });
        case "not_logged_in":
          return m.runtime_auth_failed_not_logged_in({ runtime });
        case "interaction_failed":
          return m.runtime_auth_failed_interaction({ runtime });
        case "process_failed":
          return m.runtime_auth_failed_process({ runtime });
      }
  }
}

/** Why a runtime cannot be signed in or out from here at all. */
export function unsupportedText(
  reason: "not_installed" | "version_unsupported" | "unsupported_installation",
  runtime: string,
): string {
  switch (reason) {
    case "not_installed":
      return m.runtime_auth_unsupported_not_installed({ runtime });
    case "version_unsupported":
      return m.runtime_auth_unsupported_version({ runtime });
    case "unsupported_installation":
      return m.runtime_auth_unsupported_installation({ runtime });
  }
}
