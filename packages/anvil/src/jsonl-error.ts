/** Adapter-authored diagnostics only; never pass raw provider output here. */
export class JsonlProtocolError extends Error {}

export class JsonlRequestError extends Error {
  constructor(readonly responseError: unknown) {
    super("code agent request failed");
  }
}
