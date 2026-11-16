import { describe, expect, test } from "bun:test";
import {
  InvalidImageError,
  InvalidStateError,
  parseImmutableImage,
  parseRemoteOutputs,
  parseState,
  renderState,
} from "./deployment";
import { digest, registryImage } from "./deploy-test-support";

const bareImage = `coforge/web@${digest}`;

describe("parseImmutableImage", () => {
  test("accepts a full digest-pinned reference", () => {
    const image = parseImmutableImage(registryImage);
    expect(image.digest).toBe(digest);
    expect(image.reference).toBe(registryImage);
  });

  test("accepts a reference without a registry host", () => {
    expect(parseImmutableImage(bareImage).digest).toBe(digest);
  });

  test("rejects a mutable latest tag", () => {
    expect(() => parseImmutableImage("registry.example/coforge/web:latest")).toThrow(
      InvalidImageError,
    );
  });

  test("rejects a branch alias tag", () => {
    expect(() => parseImmutableImage("coforge/web:main")).toThrow(InvalidImageError);
  });

  test("rejects a reference without a digest", () => {
    expect(() => parseImmutableImage("coforge/web")).toThrow(InvalidImageError);
  });

  test("rejects an unknown digest algorithm", () => {
    expect(() => parseImmutableImage(`coforge/web@md5:${"a".repeat(32)}`)).toThrow(
      InvalidImageError,
    );
  });

  test("rejects a truncated digest", () => {
    expect(() => parseImmutableImage(`coforge/web@${"sha256:"}${"a".repeat(63)}`)).toThrow(
      InvalidImageError,
    );
  });

  test("rejects an uppercase digest", () => {
    expect(() => parseImmutableImage(`coforge/web@sha256:${"A".repeat(64)}`)).toThrow(
      InvalidImageError,
    );
  });
});

describe("parseState", () => {
  test("parses an empty environment as bootstrap state", () => {
    const state = parseState("CURRENT_WEB_IMAGE=\nPREVIOUS_WEB_IMAGE=\n");
    expect(state.currentWebImage).toBeNull();
    expect(state.previousWebImage).toBeNull();
  });

  test("parses a current image with an empty previous", () => {
    const state = parseState(`CURRENT_WEB_IMAGE=${registryImage}\nPREVIOUS_WEB_IMAGE=\n`);
    expect(state.currentWebImage).toBe(registryImage);
    expect(state.previousWebImage).toBeNull();
  });

  test("rejects a mutable image in state", () => {
    expect(() => parseState("CURRENT_WEB_IMAGE=coforge/web:latest\nPREVIOUS_WEB_IMAGE=\n")).toThrow(
      InvalidImageError,
    );
  });

  test("rejects a malformed line", () => {
    expect(() => parseState("garbage line\n")).toThrow(InvalidStateError);
  });

  test("rejects an unknown key", () => {
    expect(() => parseState("CURRENT_IMAGE=\nPREVIOUS_WEB_IMAGE=\n")).toThrow(InvalidStateError);
  });

  test("rejects a duplicate key", () => {
    expect(() => parseState(`CURRENT_WEB_IMAGE=${registryImage}\nCURRENT_WEB_IMAGE=\n`)).toThrow(
      InvalidStateError,
    );
  });

  test("rejects a missing key", () => {
    expect(() => parseState("CURRENT_WEB_IMAGE=\n")).toThrow(InvalidStateError);
  });

  test("round-trips through renderState", () => {
    const state = parseState(`CURRENT_WEB_IMAGE=${registryImage}\nPREVIOUS_WEB_IMAGE=${bareImage}`);
    expect(parseState(renderState(state))).toEqual(state);
  });
});

describe("parseRemoteOutputs", () => {
  test("parses a healthy report", () => {
    const outputs = parseRemoteOutputs(
      ["previous_web_image=", "health_result=healthy", "outcome=healthy", "rollback_target="].join(
        "\n",
      ),
    );
    expect(outputs.outcome).toBe("healthy");
    expect(outputs.previousWebImage).toBeNull();
    expect(outputs.rollbackTarget).toBeNull();
  });

  test("parses a rollback report", () => {
    const outputs = parseRemoteOutputs(
      [
        `previous_web_image=${registryImage}`,
        "health_result=failed: candidate unhealthy",
        "outcome=rolled_back",
        `rollback_target=${registryImage}`,
      ].join("\n"),
    );
    expect(outputs.outcome).toBe("rolled_back");
    expect(outputs.previousWebImage).toBe(registryImage);
    expect(outputs.rollbackTarget).toBe(registryImage);
  });

  test("rejects a malformed line", () => {
    expect(() => parseRemoteOutputs("garbage\n")).toThrow();
  });

  test("rejects an unexpected key", () => {
    expect(() => parseRemoteOutputs("secret=x\noutcome=healthy\n")).toThrow();
  });

  test("rejects a missing key", () => {
    expect(() => parseRemoteOutputs("outcome=healthy\n")).toThrow();
  });
});
