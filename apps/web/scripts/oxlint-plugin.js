const noNativeTitle = {
  create(context) {
    return {
      JSXAttribute(node) {
        const element = node.parent.name;
        if (
          node.name.type === "JSXIdentifier" &&
          node.name.name === "title" &&
          element.type === "JSXIdentifier" &&
          /^[a-z]/.test(element.name)
        ) {
          context.report({
            node,
            message: "Do not use the native title attribute; use the shared Tooltip component.",
          });
        }
      },
    };
  },
};

const noNativeSelect = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "select") {
          context.report({
            node,
            message: "Do not use the native select element; use the shared Select or Combobox.",
          });
        }
      },
    };
  },
};

const noNativeButton = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "button") return;
        context.report({
          node,
          message: "Do not use native <button> elements; use the shared Button component.",
        });
      },
    };
  },
};

/**
 * One avatar for anyone shown by face (task #510): pages draw a person or an Agent with
 * `ActorAvatar`, which decides the status dot by its required `presence`. `IdentityAvatar` is
 * what that draws with; only `features/avatars/` and `AgentDisplayAvatar` (an Agent's live dot)
 * use it directly.
 */
const ONE_AVATAR_ALLOWED = [
  /\/src\/features\/avatars\//,
  /\/src\/features\/agents\/agent-display-avatar\.tsx$/,
];

const oneAvatar = {
  create(context) {
    const file = (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
    if (ONE_AVATAR_ALLOWED.some((allowed) => allowed.test(file))) return {};
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "IdentityAvatar") return;
        context.report({
          node,
          message:
            "Draw a person or an Agent with ActorAvatar (features/avatars/actor-avatar), saying whether it shows a status dot; IdentityAvatar is its internal part.",
        });
      },
    };
  },
};

export default {
  meta: {
    name: "coforge",
  },
  rules: {
    "one-avatar": oneAvatar,
    "no-native-button": noNativeButton,
    "no-native-select": noNativeSelect,
    "no-native-title": noNativeTitle,
  },
};
