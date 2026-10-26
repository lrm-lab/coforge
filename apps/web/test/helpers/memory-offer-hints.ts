/** Test publishers that do not persist or expose a delivered Hint. */
export const fixtureMemoryOfferHints = {
  async find() {
    return null;
  },
  async prepare() {
    return { hint_id: "test-hint", tool: "memory_disposition" as const };
  },
};
