import { expect, test } from "bun:test";

import {
  githubStepAction,
  githubStepHref,
  githubStepPlan,
  isDefaultStartPage,
} from "#src/features/onboarding/github-step";

// What the "Connect GitHub" step after creating a Workspace does for each GitHub status, and where
// "Skip for now" and the finished flow go.

test("a deployment without GitHub, or a viewer already connected, skips the step", () => {
  expect(githubStepPlan({ status: "unconfigured", slug: "acme" })).toEqual({
    kind: "skip",
    href: "/w/acme",
  });
  expect(githubStepPlan({ status: "connected", slug: "acme" })).toEqual({
    kind: "skip",
    href: "/w/acme",
  });
});

test("every other status asks, with the flow that fits it", () => {
  expect(githubStepPlan({ status: "disconnected", slug: "acme" })).toEqual({
    kind: "ask",
    action: "connect",
    next: "/w/acme",
  });
  expect(githubStepPlan({ status: "pending_installation", slug: "acme" })).toEqual({
    kind: "ask",
    action: "install",
    next: "/w/acme",
  });
  expect(githubStepPlan({ status: "reauthorize", slug: "acme" })).toEqual({
    kind: "ask",
    action: "reauthorize",
    next: "/w/acme",
  });
});

test("next is a page of this site, else the Workspace home", () => {
  expect(githubStepPlan({ status: "connected", slug: "acme", next: "/w/acme/tasks" })).toEqual({
    kind: "skip",
    href: "/w/acme/tasks",
  });
  for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "tasks", ""]) {
    expect(githubStepPlan({ status: "connected", slug: "acme", next })).toEqual({
      kind: "skip",
      href: "/w/acme",
    });
  }
});

test("a next that is the step itself would loop, so it falls back to the Workspace home", () => {
  for (const next of [
    "/w/acme/connect-github",
    "/w/other/connect-github?next=%2F",
    "/en/w/acme/connect-github",
  ]) {
    expect(githubStepPlan({ status: "connected", slug: "acme", next })).toEqual({
      kind: "skip",
      href: "/w/acme",
    });
  }
});

test("each status maps to one flow, none for unconfigured or connected", () => {
  expect(githubStepAction("disconnected")).toBe("connect");
  expect(githubStepAction("pending_installation")).toBe("install");
  expect(githubStepAction("reauthorize")).toBe("reauthorize");
  expect(githubStepAction("connected")).toBeNull();
  expect(githubStepAction("unconfigured")).toBeNull();
});

test("the step's URL carries next only when it is not the Workspace home", () => {
  expect(githubStepHref("acme")).toBe("/w/acme/connect-github");
  expect(githubStepHref("acme", "/w/acme")).toBe("/w/acme/connect-github");
  expect(githubStepHref("acme", "/w/acme/tasks?x=1")).toBe(
    "/w/acme/connect-github?next=%2Fw%2Facme%2Ftasks%3Fx%3D1",
  );
});

test("only no returnTo, or the start page itself, is the default start page", () => {
  expect(isDefaultStartPage(undefined)).toBe(true);
  expect(isDefaultStartPage("/")).toBe(true);
  for (const root of ["/en", "/en/", "/zh-CN", "/zh-CN/"])
    expect(isDefaultStartPage(root)).toBe(true);
  expect(isDefaultStartPage("/en/join/abc")).toBe(false);
  expect(isDefaultStartPage("/join/abc")).toBe(false);
  expect(isDefaultStartPage("/w/acme")).toBe(false);
});
