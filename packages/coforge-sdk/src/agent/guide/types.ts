export type GuideAudience = "managed" | "external";

export type GuideFeatures = {
  taskConversations?: boolean;
  artifacts?: boolean;
  artifactChecks?: boolean;
};

export type CloudComputerSkillsCapability = {
  readonly sharedDirectory: string;
  readonly agentDirectory: string;
};

export type GuideCapabilities = {
  cloudDesktop?: boolean;
  cloudSkills?: CloudComputerSkillsCapability;
};

export type CoforgeCliGuideOptions = {
  audience?: GuideAudience;
  features?: GuideFeatures;
  extraCriticalRules?: readonly string[];
  capabilities?: GuideCapabilities;
};

export type FeatureGuideContext = {
  audience: GuideAudience;
  features?: GuideFeatures;
  capabilities?: GuideCapabilities;
};

export type FeatureGuideEntry = {
  readonly id: string;
  readonly manualTopics: readonly string[];
  readonly audience?: GuideAudience;
  readonly isEnabled?: (context: FeatureGuideContext) => boolean;
  readonly render: (context: FeatureGuideContext) => string;
};

export type ResolvedFeatureGuide = {
  readonly id: string;
  readonly manualTopics: readonly string[];
  readonly section: string;
};

export type CoforgeCliGuideSections = {
  communication: string;
  messages: string;
  execution: string;
  queue: string;
  safety: string;
} & Record<string, string>;
