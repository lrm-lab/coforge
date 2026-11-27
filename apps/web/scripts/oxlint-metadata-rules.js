const TRAILING_COLON_RE = /[:：]$/;
const FLEX_ROW_TOKEN_RE = /(?:^|:)(?:inline-)?flex$/;
const FLEX_VERTICAL_OR_SPREAD_TOKEN_RE =
  /(?:^|:)(?:flex-col(?:-reverse)?|justify-between|(?:inline-)?grid)$/;
const FIXED_LABEL_WIDTH_TOKEN_RE = /(?:^|:)(?:w|basis)-(?!auto$|fit$|full$|min$|max$).+/;
const EDGE_ALIGNED_VALUE_TOKEN_RE = /(?:^|:)(?:ms|ml)-auto$/;

function trailingTextOfValue(node) {
  if (!node) return undefined;
  if (node.type === "JSXText") return node.value.trimEnd();
  if (node.type === "Literal" && typeof node.value === "string") return node.value.trimEnd();
  if (node.type === "JSXExpressionContainer") {
    return trailingTextOfValue(node.expression);
  }
  if (node.type === "TemplateLiteral" && node.quasis?.length) {
    const lastQuasi = node.quasis[node.quasis.length - 1];
    const text = lastQuasi?.value?.cooked ?? lastQuasi?.value?.raw;
    return typeof text === "string" ? text.trimEnd() : undefined;
  }
  return undefined;
}

function collectJsxElementsInExpression(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.type === "JSXElement") {
    if (
      node.openingElement?.name?.type === "JSXIdentifier" &&
      node.openingElement.name.name === "dl"
    ) {
      return;
    }
    out.push(node);
    for (const child of node.children ?? []) collectJsxElementsInExpression(child, out);
    return;
  }
  if (node.type === "JSXFragment") {
    for (const child of node.children ?? []) collectJsxElementsInExpression(child, out);
    return;
  }
  if (node.type === "JSXExpressionContainer") {
    collectJsxElementsInExpression(node.expression, out);
    return;
  }
  if (node.type === "CallExpression") {
    for (const arg of node.arguments ?? []) collectJsxElementsInExpression(arg, out);
    return;
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    collectJsxElementsInExpression(node.body, out);
    return;
  }
  if (node.type === "BlockStatement") {
    for (const stmt of node.body ?? []) collectJsxElementsInExpression(stmt, out);
    return;
  }
  if (node.type === "ReturnStatement") {
    collectJsxElementsInExpression(node.argument, out);
    return;
  }
  if (node.type === "ConditionalExpression") {
    collectJsxElementsInExpression(node.consequent, out);
    collectJsxElementsInExpression(node.alternate, out);
    return;
  }
  if (node.type === "LogicalExpression") {
    collectJsxElementsInExpression(node.left, out);
    collectJsxElementsInExpression(node.right, out);
    return;
  }
  if (node.type === "ParenthesizedExpression") {
    collectJsxElementsInExpression(node.expression, out);
  }
}

export function createMetadataRules({
  collectClassStrings,
  normalizedFilename,
  upstreamOfficialFiles,
}) {
  function getElementClassTokens(openingElement) {
    const strings = [];
    for (const attr of openingElement?.attributes ?? []) {
      if (
        attr.type === "JSXAttribute" &&
        attr.name?.type === "JSXIdentifier" &&
        attr.name.name === "className"
      ) {
        collectClassStrings(attr.value, strings);
      }
    }
    return strings.flatMap((value) => value.trim().split(/\s+/)).filter(Boolean);
  }

  const noDtColon = {
    create(context) {
      if (upstreamOfficialFiles.test(normalizedFilename(context))) return {};
      return {
        JSXElement(node) {
          const name = node.openingElement?.name;
          if (name?.type !== "JSXIdentifier") return;
          if (name.name === "KeyValueRow") {
            for (const attr of node.openingElement.attributes ?? []) {
              if (
                attr.type === "JSXAttribute" &&
                attr.name?.type === "JSXIdentifier" &&
                attr.name.name === "label"
              ) {
                const trailing = trailingTextOfValue(attr.value);
                if (trailing && TRAILING_COLON_RE.test(trailing)) {
                  context.report({
                    node: attr,
                    message:
                      "Do not put a trailing colon in metadata labels; separate key and value with KeyValueList layout spacing and muted label tone (see docs/design/field-display.md).",
                  });
                }
              }
            }
            return;
          }
          if (name.name !== "dt") return;
          const children = node.children ?? [];
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child.type === "JSXText" && child.value.trim() === "") continue;
            const trailing = trailingTextOfValue(child);
            if (trailing && TRAILING_COLON_RE.test(trailing)) {
              context.report({
                node: node.openingElement,
                message:
                  "Do not put a trailing colon in <dt> metadata labels; separate key and value with KeyValueList layout spacing and muted label tone (see docs/design/field-display.md).",
              });
            }
            break;
          }
        },
      };
    },
  };

  const noRaggedDl = {
    create(context) {
      if (upstreamOfficialFiles.test(normalizedFilename(context))) return {};
      return {
        JSXElement(node) {
          const name = node.openingElement?.name;
          if (name?.type !== "JSXIdentifier" || name.name !== "dl") return;
          const descendants = [];
          for (const child of node.children ?? [])
            collectJsxElementsInExpression(child, descendants);
          for (const row of descendants) {
            const rowName = row.openingElement?.name;
            if (rowName?.type !== "JSXIdentifier" || !/^[a-z]/.test(rowName.name)) continue;
            const rowTokens = getElementClassTokens(row.openingElement);
            if (
              !rowTokens.some((token) => FLEX_ROW_TOKEN_RE.test(token)) ||
              rowTokens.some((token) => FLEX_VERTICAL_OR_SPREAD_TOKEN_RE.test(token))
            )
              continue;
            const directChildren = (row.children ?? []).filter((c) => c.type === "JSXElement");
            const dtNode = directChildren.find(
              (c) =>
                c.openingElement?.name?.type === "JSXIdentifier" &&
                c.openingElement.name.name === "dt",
            );
            const ddNode = directChildren.find(
              (c) =>
                c.openingElement?.name?.type === "JSXIdentifier" &&
                c.openingElement.name.name === "dd",
            );
            if (!dtNode || !ddNode) continue;
            const dtTokens = getElementClassTokens(dtNode.openingElement);
            const ddTokens = getElementClassTokens(ddNode.openingElement);
            if (
              dtTokens.some((token) => FIXED_LABEL_WIDTH_TOKEN_RE.test(token)) ||
              ddTokens.some((token) => EDGE_ALIGNED_VALUE_TOKEN_RE.test(token))
            )
              continue;
            context.report({
              node: row.openingElement,
              message:
                "Do not lay out <dt>/<dd> rows with unaligned horizontal flex; use KeyValueList (#src/components/ui/key-value-list) so values align along one vertical axis (see docs/design/field-display.md).",
            });
          }
        },
      };
    },
  };

  return { noDtColon, noRaggedDl };
}
