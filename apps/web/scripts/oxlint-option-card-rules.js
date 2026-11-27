function isEmptyHintValue(valueNode) {
  if (!valueNode) return false;
  if (valueNode.type === "Literal") {
    return valueNode.value === "" || valueNode.value === null || valueNode.value === false;
  }
  if (valueNode.type === "JSXExpressionContainer") {
    const expr = valueNode.expression;
    if (expr?.type === "Identifier" && expr.name === "undefined") return true;
    if (expr?.type === "Literal") {
      return expr.value === "" || expr.value === null || expr.value === false;
    }
  }
  return false;
}

export function createOptionCardRules({ normalizedFilename, upstreamOfficialFiles }) {
  const noHintedRadioButton = {
    create(context) {
      if (upstreamOfficialFiles.test(normalizedFilename(context))) return {};
      return {
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || node.name.name !== "RadioButton") return;
          for (const attr of node.attributes ?? []) {
            if (
              attr.type === "JSXAttribute" &&
              attr.name?.type === "JSXIdentifier" &&
              attr.name.name === "hint" &&
              !isEmptyHintValue(attr.value)
            ) {
              context.report({
                node: attr,
                message:
                  "Do not pass hint to a bare RadioButton; use OptionCardGroup and OptionCard (#src/components/ui/option-card) for single-select options with subtitles or pricing (see docs/design/component-decisions.md).",
              });
            }
          }
        },
      };
    },
  };

  return { noHintedRadioButton };
}
