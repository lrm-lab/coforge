type ModelCatalog = {
  provider: string;
  models: readonly { id: string; displayName: string; modelProvider: string }[];
};

/**
 * What an Agent's model is called: the name its Computer's catalog gives it, else the model id. A
 * runtime's id can be an opaque token (DSH's is a JSON route/model pair), so the id is shown only
 * when the catalog does not list the model. Resolved on the server for the Workspace's model list
 * (`listVisibleAgentModels`), which the chat label, the profile, its hover card and the Computer's
 * Agent list all read.
 */
export function agentModelName(
  catalogs: readonly ModelCatalog[] | undefined,
  choice: { runtime: string; model: string; modelProvider?: string },
) {
  const models = catalogs
    ?.find((catalog) => catalog.provider === choice.runtime)
    ?.models.filter((model) => model.id === choice.model);
  // The entry for the Agent's own model provider first, then one that names no provider.
  const listed =
    models?.find((model) => model.modelProvider === (choice.modelProvider ?? "")) ??
    models?.find((model) => !choice.modelProvider || !model.modelProvider);
  return listed?.displayName || choice.model;
}
