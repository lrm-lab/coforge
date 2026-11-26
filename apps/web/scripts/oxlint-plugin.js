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

const HOVER_PRIMITIVE_FILES = [
  /\/src\/components\/base\/tooltip\//,
  /\/src\/components\/ui\/hover-popover\.tsx$/,
];

const HOVER_DELAY_COMPONENTS = new Set(["Tooltip", "HoverPopover"]);
const HOVER_DELAY_PROPS = new Set(["delay", "closeDelay"]);

const noCustomHoverDelay = {
  create(context) {
    const file = normalizedFilename(context);
    if (HOVER_PRIMITIVE_FILES.some((allowed) => allowed.test(file))) return {};
    return {
      JSXAttribute(node) {
        const element = node.parent?.name;
        if (
          node.name?.type === "JSXIdentifier" &&
          HOVER_DELAY_PROPS.has(node.name.name) &&
          element?.type === "JSXIdentifier" &&
          HOVER_DELAY_COMPONENTS.has(element.name)
        ) {
          context.report({
            node,
            message:
              "Do not override delay or closeDelay on Tooltip or HoverPopover; use the shared timing defaults (500ms label, 700ms/300ms card) and wrap sibling triggers in TooltipGroup or HoverCardGroup.",
          });
        }
      },
    };
  },
};

const RAW_HOVER_SPECIFIERS = new Set(["PreviewTrigger", "TooltipTrigger"]);

const noRawHoverPrimitives = {
  create(context) {
    const file = normalizedFilename(context);
    if (HOVER_PRIMITIVE_FILES.some((allowed) => allowed.test(file))) return {};
    return {
      ImportDeclaration(node) {
        if (node.source?.value !== "react-aria-components") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type !== "ImportSpecifier") continue;
          const importedName = specifier.imported?.name;
          if (importedName && RAW_HOVER_SPECIFIERS.has(importedName)) {
            context.report({
              node: specifier,
              message:
                "Do not import PreviewTrigger or TooltipTrigger directly from react-aria-components; use the shared Tooltip/TooltipGroup or HoverPopover/HoverCardGroup primitives.",
            });
          }
        }
      },
    };
  },
};

const SUBMENU_INPUT_COMPONENTS = new Set([
  "PickerMenu",
  "SearchField",
  "AriaSearchField",
  "Input",
  "AriaInput",
  "TextArea",
  "input",
  "textarea",
]);

function isSubmenuTriggerName(nameNode) {
  if (!nameNode) return false;
  if (nameNode.type === "JSXIdentifier") return nameNode.name === "DropdownSubmenuTrigger";
  if (nameNode.type === "JSXMemberExpression") {
    return (
      nameNode.object?.type === "JSXIdentifier" &&
      nameNode.object.name === "Dropdown" &&
      nameNode.property?.type === "JSXIdentifier" &&
      nameNode.property.name === "SubmenuTrigger"
    );
  }
  return false;
}

function hasOpenOnHoverFalse(openingElement) {
  for (const attr of openingElement.attributes ?? []) {
    if (attr.type !== "JSXAttribute" || attr.name?.name !== "openOnHover") continue;
    if (
      attr.value?.type === "JSXExpressionContainer" &&
      attr.value.expression?.type === "Literal" &&
      attr.value.expression.value === false
    ) {
      return true;
    }
  }
  return false;
}

function containsTypingComponent(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "JSXElement") {
    const nameNode = node.openingElement?.name;
    if (nameNode?.type === "JSXIdentifier" && SUBMENU_INPUT_COMPONENTS.has(nameNode.name)) {
      return true;
    }
  }
  for (const child of node.children ?? []) {
    if (containsTypingComponent(child)) return true;
  }
  if (node.type === "JSXExpressionContainer" && node.expression) {
    return containsTypingComponent(node.expression);
  }
  return false;
}

const noHoverInputSubmenu = {
  create(context) {
    return {
      JSXElement(node) {
        if (!isSubmenuTriggerName(node.openingElement?.name)) return;
        if (hasOpenOnHoverFalse(node.openingElement)) return;
        if (containsTypingComponent(node)) {
          context.report({
            node: node.openingElement,
            message:
              "Submenus containing inputs or searchable pickers must not open on hover; pass openOnHover={false} on Dropdown.SubmenuTrigger.",
          });
        }
      },
    };
  },
};

const SYNC_MOTION_PACKAGES = new Set(["motion/react", "framer-motion"]);

const noSyncMotionImport = {
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!SYNC_MOTION_PACKAGES.has(node.source?.value)) return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type === "ImportSpecifier" && specifier.imported?.name === "motion") {
            context.report({
              node: specifier,
              message:
                'Do not import synchronous motion from "motion/react"; use `import * as motion from "motion/react-m"` under LazyMotion strict.',
            });
          }
        }
      },
    };
  },
};

const BROWSER_DIALOG_HOSTS = new Set(["window", "globalThis"]);
const BROWSER_DIALOG_METHODS = new Set(["alert", "confirm", "prompt"]);

const noBrowserDialogs = {
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type === "MemberExpression" &&
          !callee.computed &&
          callee.object?.type === "Identifier" &&
          BROWSER_DIALOG_HOSTS.has(callee.object.name) &&
          callee.property?.type === "Identifier" &&
          BROWSER_DIALOG_METHODS.has(callee.property.name)
        ) {
          context.report({
            node,
            message:
              "Do not use browser window.alert/confirm/prompt dialogs; use ConfirmDialog, Popconfirm, or Alert.",
          });
        }
      },
    };
  },
};

const FORBIDDEN_TOAST_PACKAGES = new Set(["sonner", "react-hot-toast", "react-toastify"]);

const noRawToastLibrary = {
  create(context) {
    return {
      ImportDeclaration(node) {
        if (FORBIDDEN_TOAST_PACKAGES.has(node.source?.value)) {
          context.report({
            node,
            message:
              "Do not import third-party toast libraries; use useAppToast from #src/components/ui/toast.",
          });
        }
      },
    };
  },
};

const FILE_TYPE_ICON_ALLOWED = [/\/src\/features\/files\//, /\/src\/components\/application\//];

const noRawFileTypeIcon = {
  create(context) {
    const file = normalizedFilename(context);
    if (FILE_TYPE_ICON_ALLOWED.some((allowed) => allowed.test(file))) return {};
    return {
      ImportDeclaration(node) {
        const source = node.source?.value;
        if (typeof source === "string" && source.startsWith("@untitledui/file-icons")) {
          context.report({
            node,
            message:
              "Do not import @untitledui/file-icons directly; use FileTypeIcon from #src/features/files/file-type-icon.",
          });
        }
      },
    };
  },
};

const DISTRACTING_ANIMATION_RE = /\banimate-(?:bounce|ping)\b/;

function collectClassStrings(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.type === "Literal" && typeof node.value === "string") {
    out.push(node.value);
    return;
  }
  if (node.type === "TemplateElement" && typeof node.value?.raw === "string") {
    out.push(node.value.raw);
    return;
  }
  if (node.type === "TemplateLiteral") {
    for (const quasi of node.quasis ?? []) collectClassStrings(quasi, out);
    for (const expr of node.expressions ?? []) collectClassStrings(expr, out);
    return;
  }
  if (node.type === "JSXExpressionContainer") {
    collectClassStrings(node.expression, out);
    return;
  }
  if (node.type === "CallExpression") {
    for (const arg of node.arguments ?? []) collectClassStrings(arg, out);
    return;
  }
  if (node.type === "LogicalExpression") {
    collectClassStrings(node.left, out);
    collectClassStrings(node.right, out);
    return;
  }
  if (node.type === "ConditionalExpression") {
    collectClassStrings(node.consequent, out);
    collectClassStrings(node.alternate, out);
    return;
  }
  if (node.type === "ArrayExpression") {
    for (const el of node.elements ?? []) collectClassStrings(el, out);
  }
}

const noDistractingAnimations = {
  create(context) {
    if (UPSTREAM_OFFICIAL_FILES.test(normalizedFilename(context))) return {};
    return {
      JSXAttribute(node) {
        if (node.name?.type !== "JSXIdentifier" || node.name.name !== "className") return;
        const strings = [];
        collectClassStrings(node.value, strings);
        if (strings.some((text) => DISTRACTING_ANIMATION_RE.test(text))) {
          context.report({
            node,
            message:
              "Do not use animate-bounce or animate-ping; CoForge motion is reserved for feedback and state continuity (see docs/design/motion.md).",
          });
        }
      },
    };
  },
};

const LEGACY_DATE_METHODS = new Set([
  "setFullYear",
  "setUTCFullYear",
  "setMonth",
  "setUTCMonth",
  "setDate",
  "setUTCDate",
  "setHours",
  "setUTCHours",
  "setMinutes",
  "setUTCMinutes",
  "setSeconds",
  "setUTCSeconds",
  "setMilliseconds",
  "setUTCMilliseconds",
  "setTime",
  "getTimezoneOffset",
  "getFullYear",
  "getUTCFullYear",
  "getMonth",
  "getUTCMonth",
  "getDate",
  "getUTCDate",
  "getDay",
  "getUTCDay",
  "getHours",
  "getUTCHours",
  "getMinutes",
  "getUTCMinutes",
  "getSeconds",
  "getUTCSeconds",
]);

const WEB_SRC_FILE = /\/src\//;

const noHandrolledDateMath = {
  create(context) {
    const file = normalizedFilename(context);
    if (!WEB_SRC_FILE.test(file) || UPSTREAM_OFFICIAL_FILES.test(file)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type === "MemberExpression" &&
          !callee.computed &&
          callee.property?.type === "Identifier" &&
          LEGACY_DATE_METHODS.has(callee.property.name)
        ) {
          context.report({
            node,
            message:
              "Do not hand-roll calendar or timezone math with legacy Date methods; use Temporal (and #src/lib/dates for Intl formatting). See apps/web/src/lib/AGENTS.md.",
          });
        }
      },
      NewExpression(node) {
        if (
          node.callee?.type === "Identifier" &&
          node.callee.name === "Date" &&
          (node.arguments?.length ?? 0) >= 2
        ) {
          context.report({
            node,
            message:
              "Do not construct local-timezone calendar dates with multi-argument new Date(year, month, ...); use Temporal.PlainDate or Temporal.ZonedDateTime. See apps/web/src/lib/AGENTS.md.",
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
    "no-custom-hover-delay": noCustomHoverDelay,
    "no-raw-hover-primitives": noRawHoverPrimitives,
    "no-hover-input-submenu": noHoverInputSubmenu,
    "no-sync-motion-import": noSyncMotionImport,
    "no-browser-dialogs": noBrowserDialogs,
    "no-raw-toast-library": noRawToastLibrary,
    "no-raw-file-type-icon": noRawFileTypeIcon,
    "no-distracting-animations": noDistractingAnimations,
    "no-handrolled-date-math": noHandrolledDateMath,
  },
};
