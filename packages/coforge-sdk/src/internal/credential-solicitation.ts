/**
 * Detects Agent outbound text that asks a person to paste a password, OTP, or
 * similar secret into chat. Best-effort: clear asks are refused; ambiguous talk
 * about passwords (including "do not send passwords") is left alone.
 */

export const CREDENTIAL_SOLICITATION_CODE = "CREDENTIAL_SOLICITATION_REFUSED";

export const CREDENTIAL_SOLICITATION_MESSAGE =
  "Do not ask people to paste passwords or verification codes into chat. Post a `page:fill` action card (or `desktop:takeover` when fill cannot work). See `coforge manual get action-cards`.";

/** English: ask the person to provide a secret. */
const ENGLISH_ASK =
  /\b(?:send|paste|tell|give|share)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:password|passwd|passcode|otp|verification\s*codes?|secrets?)\b|\b(?:type|enter|put)\s+(?:your\s+|the\s+)?(?:password|passwd|passcode|otp|verification\s*codes?)\s+(?:here|below|in\s+(?:the\s+)?(?:chat|message|reply|dialog(?:ue)?|box))\b|\bwhat(?:'s| is)\s+your\s+password\b|\breply\s+with\s+(?:your\s+|the\s+)?(?:password|passwd|otp|verification\s*codes?)\b/gi;

/** Chinese: 把密码/验证码发给我、粘贴到聊天，等. */
const CHINESE_ASK =
  /(?:把)?(?:密码|口令|验证码|动态码|校验码).{0,10}(?:发|告诉|粘贴|输入|打).{0,8}(?:我|聊天|对话|对话框|这里)|(?:发|告诉|粘贴).{0,6}(?:我)?.{0,4}(?:密码|口令|验证码|动态码|校验码)|(?:密码|验证码|口令).{0,6}(?:发过来|发到聊天|发到对话|发到对话框)/g;

const NEGATION_BEFORE = /(?:don'?t|do\s+not|never|不要|别|勿|禁止|请勿|切勿)\s*$/i;

function hasUnnegatedMatch(text: string, pattern: RegExp): boolean {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 16), match.index);
    if (NEGATION_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * True when `text` asks the reader to put a password / OTP / similar secret into
 * the chat. Negated wording ("don't send me the password") does not match.
 */
export function solicitsCredentialsInChat(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return hasUnnegatedMatch(normalized, ENGLISH_ASK) || hasUnnegatedMatch(normalized, CHINESE_ASK);
}
