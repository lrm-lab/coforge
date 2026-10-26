import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Heading } from "react-aria-components";
import { useServerFn } from "@tanstack/react-start";
import { useRouter } from "@tanstack/react-router";
import { Copy01, LinkExternal01, XClose } from "@untitledui/icons";
import type { KiroIdentityCenterOptions, RuntimeAuthProvider } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";
import {
  cancelRuntimeAuthLogin,
  readRuntimeAuthLogin,
  startRuntimeAuthLogin,
  submitRuntimeAuthCode,
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
import { KiroEnterpriseSignIn } from "./kiro-enterprise-sign-in";
import { useRuntimeAuthSignals } from "./use-runtime-auth-signals";

type Target = {
  computerId: string;
  computerName: string;
  provider: RuntimeAuthProvider;
  runtimeName: string;
};

/** At most this many views wait for the login id the start returns; a login sends far fewer. */
const EARLY_VIEW_LIMIT = 16;

/**
 * Signs a Computer's runtime in from the web, as on Raft: the dialog shows what the runtime's own
 * flow asks for (a page to open, a device code, a code to paste back) until it ends. The code and
 * the link live only in this dialog's state; closing it drops them and cancels a running login.
 */
export function RuntimeSignInDialog({ onClose, ...target }: Target & { onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [kiroIdentityCenter, setKiroIdentityCenter] = useState<KiroIdentityCenterOptions>();
  const closeAction = useRef<(() => void) | undefined>(undefined);
  const router = useRouter();
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
        <Dialog className="overflow-hidden text-left">
          {target.provider === RUNTIME_PROVIDER.KIRO && !kiroIdentityCenter ? (
            <KiroEnterpriseSignIn onStart={setKiroIdentityCenter} onClose={onClose} />
          ) : (
            <SignInAttempt
              key={attempt}
              {...target}
              kiroIdentityCenter={kiroIdentityCenter}
              closeAction={closeAction}
              onRetry={() => {
                setAttempt((n) => n + 1);
                setKiroIdentityCenter(undefined);
              }}
              onClose={(signedIn) => {
                if (signedIn) void router.invalidate();
                onClose();
              }}
            />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function SignInAttempt({
  computerId,
  computerName,
  provider,
  runtimeName,
  kiroIdentityCenter,
  closeAction,
  onRetry,
  onClose,
}: Target & {
  kiroIdentityCenter?: KiroIdentityCenterOptions;
  closeAction: RefObject<(() => void) | undefined>;
  onRetry: () => void;
  onClose: (signedIn: boolean) => void;
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
      if (signal.type !== "runtime-auth.login.v1" || signal.provider !== provider) return;
      if (loginId.current) dispatch({ type: "view", view: signal, now: Date.now() });
      else if (early.current.length < EARLY_VIEW_LIMIT) early.current.push(signal);
    },
  });

  useEffect(() => {
    // Once per attempt, on a guard rather than cleanup: StrictMode's second run must not start a
    // second login, and only closing the dialog cancels one.
    if (began.current) return;
    began.current = true;
    start({ data: { computerId, provider, ...(kiroIdentityCenter ? { kiroIdentityCenter } : {}) } })
      .then((started) => {
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

  const running = state.phase === "starting" || state.phase === "running";
  const close = () => {
    closed.current = true;
    if (running && loginId.current)
      void cancel({ data: { computerId, loginId: loginId.current } }).catch(() => {});
    onClose(state.phase === "signed_in");
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
      <div className="flex justify-end gap-3 px-6 pt-5 pb-5">
        {state.phase === "signed_in" ? (
          <Button onPress={close}>{m.runtime_auth_done()}</Button>
        ) : (
          <>
            <Button color="link-gray" onPress={close}>
              {running ? m.controls_cancel() : m.controls_close()}
            </Button>
            {state.phase === "failed" && retryable(state.failure) && (
              <Button onPress={onRetry}>{m.runtime_auth_try_again()}</Button>
            )}
          </>
        )}
      </div>
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
      return <p role="status">{m.runtime_auth_starting({ computer: computerName })}</p>;
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
          {state.info && <p className="text-tertiary">{state.info}</p>}
          {state.prompt !== undefined && !state.checking && (
            <CodeForm
              computerId={computerId}
              loginId={state.loginId}
              rejected={state.rejected}
              dispatch={dispatch}
            />
          )}
          {state.checking && <p role="status">{m.runtime_auth_checking()}</p>}
          {!state.link && !state.info && state.prompt === undefined && (
            <p role="status">{m.runtime_auth_starting({ computer: computerName })}</p>
          )}
        </>
      );
  }
}

/** One sentence for every runtime, as on Raft: the runtime's own instructions are not shown. */
function AuthPage({ url }: { url: string }) {
  const safe = safeSignInUrl(url);
  return (
    <>
      <p>{m.runtime_auth_open_page_hint()}</p>
      <Button
        size="sm"
        iconTrailing={LinkExternal01}
        isDisabled={!safe}
        onPress={() => safe && window.open(safe, "_blank", "noopener,noreferrer")}
      >
        {m.runtime_auth_open_page()}
      </Button>
    </>
  );
}

function DeviceCode({
  event,
  expiresAtMs,
}: {
  event: { verificationUrl: string; userCode: string };
  expiresAtMs?: number;
}) {
  const safe = safeSignInUrl(event.verificationUrl);
  const minutes = expiresAtMs === undefined ? 0 : Math.ceil((expiresAtMs - Date.now()) / 60_000);
  return (
    <>
      <p>{m.runtime_auth_device_hint()}</p>
      {safe && (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-medium text-brand-secondary underline"
        >
          {safe}
        </a>
      )}
      <div className="flex items-center gap-2">
        <code className="rounded-md bg-secondary px-3 py-2 font-mono text-lg font-semibold tracking-widest text-primary">
          {event.userCode}
        </code>
        <ButtonUtility
          icon={Copy01}
          size="sm"
          color="secondary"
          tooltip={m.runtime_auth_copy_code()}
          onClick={() => void copyText(event.userCode)}
        />
      </div>
      {minutes > 0 && (
        <p className="text-tertiary">{m.runtime_auth_code_expires({ minutes: String(minutes) })}</p>
      )}
    </>
  );
}

function CodeForm({
  computerId,
  loginId,
  rejected,
  dispatch,
}: {
  computerId: string;
  loginId: string;
  rejected: boolean;
  dispatch: (action: Parameters<typeof loginReducer>[1]) => void;
}) {
  const submit = useServerFn(submitRuntimeAuthCode);
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [sending, setSending] = useState(false);
  const hintId = useId();
  const error = invalid
    ? m.runtime_auth_code_invalid()
    : rejected
      ? m.runtime_auth_code_rejected()
      : undefined;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (sending || !code.trim()) return;
        setSending(true);
        setInvalid(false);
        void submit({ data: { computerId, loginId, code } })
          .then((outcome) => {
            if (outcome === "sent") {
              setCode("");
              dispatch({ type: "code_sent" });
            } else if (outcome === "invalid_code") {
              setInvalid(true);
              dispatch({ type: "code_invalid" });
            } else dispatch({ type: "ended" });
          })
          .catch(() => setInvalid(true))
          .finally(() => setSending(false));
      }}
    >
      {/* As on Raft: Submit sits beside the field, and the line under it says where the code
          comes from until it has to say what is wrong. */}
      <div className="flex items-end gap-2">
        <Input
          className="min-w-0 flex-1"
          label={m.runtime_auth_paste_label()}
          aria-describedby={hintId}
          isInvalid={Boolean(error)}
          value={code}
          onChange={setCode}
          autoComplete="off"
          spellCheck="false"
        />
        <Button
          type="submit"
          size="md"
          color="secondary"
          isLoading={sending}
          isDisabled={!code.trim()}
        >
          {m.runtime_auth_submit()}
        </Button>
      </div>
      <p
        id={hintId}
        role={error ? "alert" : undefined}
        className={error ? "mt-1.5 text-xs text-error-primary" : "mt-1.5 text-xs text-tertiary"}
      >
        {error ?? m.runtime_auth_paste_hint()}
      </p>
    </form>
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
