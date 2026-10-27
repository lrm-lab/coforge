import { expect, test } from "bun:test";

import {
  initialLoginState,
  loginReducer,
  retryable,
  safeSignInUrl,
  type LoginAction,
  type LoginState,
  type LoginView,
} from "#src/features/computers/runtime-auth-login-state";

const loginId = "rtl_aaaaaaaaaaaaaaaa";
const device: LoginView = {
  loginId,
  sequence: 1,
  event: {
    kind: "device_code",
    verificationUrl: "https://auth.example/device",
    userCode: "ABCD-1234",
    expiresInSeconds: 600,
  },
};
const info: LoginView = { loginId, sequence: 2, event: { kind: "info", message: "Waiting" } };
const done: LoginView = {
  loginId,
  sequence: 3,
  result: { kind: "logged_in", account: { maskedLabel: "f***@x.com" } },
};

function run(...actions: LoginAction[]): LoginState {
  return actions.reduce(loginReducer, initialLoginState);
}
const started: LoginAction = { type: "started", loginId };
const view = (v: LoginView): LoginAction => ({ type: "view", view: v, now: 0 });

test("an info line keeps the device code the reader still has to type", () => {
  const state = run(started, view(device), view(info));
  expect(state).toMatchObject({
    phase: "running",
    link: device.event,
    expiresAtMs: 600_000,
    info: "Waiting",
  });
});

test("a catch-up code prompt keeps the authorization link that arrived before it", () => {
  const authUrl = { kind: "auth_url" as const, url: "https://claude.ai/oauth" };
  const state = run(
    started,
    view({ loginId, sequence: 2, authUrl, event: { kind: "code_prompt", message: "Paste" } }),
  );
  expect(state).toMatchObject({ phase: "running", link: authUrl, prompt: "Paste" });
});

test("a later catch-up event cannot replace an already shown authorization link", () => {
  const authUrl = { kind: "auth_url" as const, url: "https://claude.ai/oauth" };
  const state = run(
    started,
    view({ loginId, sequence: 1, event: authUrl }),
    view({ loginId, sequence: 2, authUrl, event: { kind: "info", message: "Waiting" } }),
  );
  expect(state).toMatchObject({ phase: "running", link: authUrl, info: "Waiting" });
});

test("the catch-up read and the channel overlap or arrive out of order; the login only moves forward", () => {
  // Read returns the latest view (2) before the channel delivers 1, then 2 again.
  const reordered = run(started, view(info), view(device), view(info));
  expect(reordered).toMatchObject({ phase: "running", sequence: 2, info: "Waiting" });
  expect(reordered).not.toHaveProperty("link");
  // A result ends it, and nothing older or repeated reopens it.
  const ended = run(started, view(device), view(done), view(info), view(device));
  expect(ended).toEqual({ phase: "signed_in", account: { maskedLabel: "f***@x.com" } });
});

test("another login's views never touch this one", () => {
  const state = run(started, view({ ...device, loginId: "rtl_bbbbbbbbbbbbbbbb" }));
  expect(state).toMatchObject({ phase: "running", sequence: -1 });
  expect(state).not.toHaveProperty("link");
});

test("a second code prompt after a code was sent means the code was not accepted", () => {
  const prompt = (sequence: number): LoginView => ({
    loginId,
    sequence,
    event: { kind: "code_prompt", message: "Paste the code" },
  });
  const first = run(started, view(prompt(1)));
  expect(first).toMatchObject({ prompt: "Paste the code", rejected: false, checking: false });
  const again = run(started, view(prompt(1)), { type: "code_sent" }, view(prompt(2)));
  expect(again).toMatchObject({ rejected: true, checking: false });
  const marked = run(
    started,
    view({ loginId, sequence: 1, event: { kind: "code_prompt", retry: true } }),
  );
  expect(marked).toMatchObject({ prompt: "", rejected: true });
  const invalid = run(started, view(prompt(1)), { type: "code_sent" }, { type: "code_invalid" });
  expect(invalid).toMatchObject({ rejected: false, checking: false });
});

test("refusals and failures end the login, and say whether a retry can help", () => {
  expect(run({ type: "start_refused", status: "busy" })).toEqual({
    phase: "failed",
    failure: { kind: "busy" },
  });
  const failed = run(
    started,
    view({ loginId, sequence: 1, result: { kind: "failed", reason: "interaction_failed" } }),
  );
  expect(failed).toEqual({
    phase: "failed",
    failure: { kind: "failed", reason: "interaction_failed" },
  });
  expect(retryable({ kind: "failed", reason: "interaction_failed" })).toBe(false);
  expect(retryable({ kind: "failed", reason: "timed_out" })).toBe(true);
  expect(retryable({ kind: "unsupported", reason: "not_installed" })).toBe(false);
  expect(retryable({ kind: "offline" })).toBe(true);
});

test("only an https sign-in page is opened", () => {
  expect(safeSignInUrl("https://claude.ai/oauth?x=1")).toBe("https://claude.ai/oauth?x=1");
  expect(safeSignInUrl("http://claude.ai/oauth")).toBeUndefined();
  expect(safeSignInUrl("javascript:alert(1)")).toBeUndefined();
  expect(safeSignInUrl("not a url")).toBeUndefined();
});
