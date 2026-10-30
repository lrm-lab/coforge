// A path as `git diff` quotes it (C-style escapes in double quotes), as plain text.
export function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, '"': 34, "\\": 92, a: 7, b: 8 };
  for (let i = 1; i < path.length - 1; i++) {
    if (path[i] !== "\\") {
      bytes.push(...Buffer.from(path[i]!));
    } else if (/[0-7]/.test(path[i + 1]!)) {
      bytes.push(parseInt(path.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[path[++i]!] ?? path.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString();
}
