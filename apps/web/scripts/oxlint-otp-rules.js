const RAW_OTP_INPUT_NAMES = new Set(["Input", "InputBase", "AriaInput", "input"]);
const OTP_PRIMITIVE_FILE = /\/src\/components\/ui\/input-otp\.tsx$/;

export function createOtpRules({ normalizedFilename, staticStringValue, upstreamOfficialFiles }) {
  const noRawOtpInput = {
    create(context) {
      const file = normalizedFilename(context);
      if (upstreamOfficialFiles.test(file) || OTP_PRIMITIVE_FILE.test(file)) return {};
      return {
        JSXOpeningElement(node) {
          if (node.name?.type !== "JSXIdentifier" || !RAW_OTP_INPUT_NAMES.has(node.name.name)) {
            return;
          }
          for (const attr of node.attributes ?? []) {
            if (
              attr.type !== "JSXAttribute" ||
              attr.name?.type !== "JSXIdentifier" ||
              attr.name.name.toLowerCase() !== "autocomplete"
            ) {
              continue;
            }
            const value = staticStringValue(attr.value);
            if (value && value.trim().toLowerCase().split(/\s+/).includes("one-time-code")) {
              context.report({
                node: attr,
                message:
                  'Do not render a single-line input with autoComplete="one-time-code"; use InputOTP (#src/components/ui/input-otp) with 3+3 grouped slots or CodeInput (see docs/design/field-display.md).',
              });
            }
          }
        },
      };
    },
  };

  return { noRawOtpInput };
}
