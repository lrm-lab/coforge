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

const ONE_AVATAR_ALLOWED = [
  /\/src\/features\/avatars\//,
  /\/src\/features\/agents\/agent-display-avatar\.tsx$/,
];

const UPSTREAM_OFFICIAL_FILES = /\/src\/components\/(?:base|application)\//;

function normalizedFilename(context) {
  return (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");
}

function staticStringValue(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (
    node.type === "JSXExpressionContainer" &&
    node.expression?.type === "Literal" &&
    typeof node.expression.value === "string"
  ) {
    return node.expression.value;
  }
  return undefined;
}

const oneAvatar = {
  create(context) {
    const file = normalizedFilename(context);
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

const noHandrolledToolbar = {
  create(context) {
    if (UPSTREAM_OFFICIAL_FILES.test(normalizedFilename(context))) return {};
    return {
      JSXAttribute(node) {
        const element = node.parent.name;
        if (
          node.name.type === "JSXIdentifier" &&
          node.name.name === "role" &&
          element.type === "JSXIdentifier" &&
          /^[a-z]/.test(element.name) &&
          staticStringValue(node.value) === "toolbar"
        ) {
          context.report({
            node,
            message:
              'Do not hand-roll role="toolbar" on native elements; use React Aria <Toolbar> (react-aria-components) for arrow-key navigation and roving focus.',
          });
        }
      },
    };
  },
};

const REACT_ARIA_BUTTON_NAMES = new Set(["Button", "AriaButton"]);

const preferOnPress = {
  create(context) {
    if (UPSTREAM_OFFICIAL_FILES.test(normalizedFilename(context))) return {};
    return {
      JSXAttribute(node) {
        const element = node.parent.name;
        if (
          node.name.type === "JSXIdentifier" &&
          node.name.name === "onClick" &&
          element.type === "JSXIdentifier" &&
          REACT_ARIA_BUTTON_NAMES.has(element.name)
        ) {
          context.report({
            node,
            message:
              "Prefer onPress over onClick on React Aria / Untitled UI Button components for consistent mouse, touch, and keyboard activation.",
          });
        }
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
    "no-handrolled-toolbar": noHandrolledToolbar,
    "prefer-on-press": preferOnPress,
  },
};
