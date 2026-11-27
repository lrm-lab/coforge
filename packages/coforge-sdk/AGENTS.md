# CoForge SDK

- `bun run generate` rewrites `src/`; format the result with `bun run format` before committing; `bun run check` runs `oxfmt --check .`.

- Protobuf schemas under `packages/coforge-sdk/proto` must pass `buf lint` and `buf format --diff --exit-code`; do not use TypeScript lint rules as a substitute for `.proto` validation.

- The Computer attach session protocol lives in `computer_attach.proto` and the
  `internal/computer-attach-session` exports. The attach proof signs a UTF-8 JSON array of
  versioned domain, HTTP(S) origin, session ID, purpose and server nonce, in that order. The
  WHATWG origin serializer lowercases the scheme and host, omits the default port and trailing
  slash, and preserves non-default ports. Credentials in the URL are refused.
- `internal/computer-attach-signature` verifies Ed25519 with strict point and scalar checks.
  Bun 1.4's built-in verifier can accept small-order points. Keep the pinned Wycheproof fixture
  coverage when replacing the verifier.
