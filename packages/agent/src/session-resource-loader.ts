import { basename, dirname } from "node:path";
import type {
  DefaultResourceLoader,
  InlineExtension,
  ResourceDiagnostic,
} from "@earendil-works/pi-coding-agent";
import {
  isCloudComputerAppendSystemPrompt,
  isCloudComputerOnlySkillName,
  isCloudComputerSkillsEnabled,
} from "./cloud-computer-skills";

type ResourceLoaderOptions = Omit<
  ConstructorParameters<typeof DefaultResourceLoader>[0],
  "cwd" | "agentDir"
>;

function isCloudComputerOnlySkillDiagnostic(diagnostic: ResourceDiagnostic): boolean {
  if (
    diagnostic.collision?.resourceType === "skill" &&
    isCloudComputerOnlySkillName(diagnostic.collision.name)
  ) {
    return true;
  }
  if (!diagnostic.path) return false;
  const file = basename(diagnostic.path);
  if (file === "SKILL.md") return isCloudComputerOnlySkillName(basename(dirname(diagnostic.path)));
  if (file.endsWith(".md")) return isCloudComputerOnlySkillName(file.slice(0, -3));
  return false;
}

export const EVAL_DISABLE_HOST_PI_INJECTION = "COFORGE_EVAL_DISABLE_HOST_PI_INJECTION";
export function evalDisablesHostPiInjection(
  env: {
    [key: string]: string | undefined;
  } = Bun.env,
): boolean {
  const value = env[EVAL_DISABLE_HOST_PI_INJECTION];
  return value === "1" || value === "true";
}
export function resourceLoaderOptionsForSession(input: {
  instructions: string;
  environment?: Readonly<Record<string, string | undefined>>;
  disableHostPiInjection?: boolean;
  extensionFactories?: InlineExtension[];
}): ResourceLoaderOptions {
  const isolate = Boolean(input.disableHostPiInjection);
  const cloudComputer = isCloudComputerSkillsEnabled(input.environment ?? Bun.env);
  return {
    systemPromptOverride: () => input.instructions,
    ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}),
    ...(isolate
      ? { noSkills: true, noContextFiles: true, noExtensions: true }
      : !cloudComputer
        ? {
            skillsOverride: ({ skills, diagnostics }) => ({
              skills: skills.filter((skill) => !isCloudComputerOnlySkillName(skill.name)),
              diagnostics: diagnostics.filter(
                (diagnostic) => !isCloudComputerOnlySkillDiagnostic(diagnostic),
              ),
            }),
            appendSystemPromptOverride: (entries) =>
              entries.filter((entry) => !isCloudComputerAppendSystemPrompt(entry)),
          }
        : {}),
  };
}
