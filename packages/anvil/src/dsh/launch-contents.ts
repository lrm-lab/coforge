/** No imports: the host embeds this source and materializes it beside the private patch. */
export const DSH_INSTRUCTIONS_PLUGIN = `export const name = 'coforge-instructions';
export const inject = ['systemPrompt'];
export function apply(ctx, config) {
  if (typeof config.instructions !== 'string') throw new TypeError('DSH CoForge instructions must be a string');
  ctx.systemPrompt.section({
    name: 'coforge:instructions',
    order: 0,
    text: config.instructions,
    interpolate: false,
  });
}
`;

/** JSON is a YAML subset; serialize data rather than interpolating native YAML/JS expressions. */
export function createDshLaunchContents(instructions: string, pluginPath: string) {
  if (typeof instructions !== "string")
    throw new TypeError("DSH CoForge instructions must be a string");
  return {
    plugin: DSH_INSTRUCTIONS_PLUGIN,
    patch: JSON.stringify([
      ...["tool-plugin-manager", "plugin-manager", "plan-mode"].map((id) => ({
        id,
        disabled: true,
      })),
      { id: "system-prompt", config: { personaPrefix: "" } },
      {
        insert: [{ id: "coforge-instructions", name: pluginPath, config: { instructions } }],
      },
    ]),
  };
}
