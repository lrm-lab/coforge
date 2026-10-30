/** Every recovered message was created at `RECOVERY_CREATED_AT_MS`. */
export const RECOVERY_CREATED_AT_MS = 1_700_000_000_000;
export const RECOVERY_CREATED_AT = new Date(RECOVERY_CREATED_AT_MS);

export const recoverySecondPassStubs = {
  messageMention: { findMany: async () => [] },
  memoryHintRecord: { findMany: async () => [] },
  messageForward: { findMany: async () => [] },
};
