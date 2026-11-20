import { isIP } from "node:net";

const ARTIFACT_ORIGIN_PATTERN = /^https:\/\/a-[a-zA-Z0-9-]{1,64}\.coforge\.check$/;

function parseIpv4Octets(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

export function isPublicIpAddress(rawIp) {
  if (typeof rawIp !== "string" || !rawIp) return false;
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(ip);
  if (version === 4) {
    const octets = parseIpv4Octets(ip);
    if (!octets) return false;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (version === 6) {
    if (ip === "::" || ip === "::1") return false;
    if (ip.startsWith("::ffff:")) {
      return isPublicIpAddress(ip.slice(7));
    }
    const firstGroup = Number.parseInt(ip.split(":")[0] || "0", 16);
    if ((firstGroup & 0xfe00) === 0xfc00) return false;
    if ((firstGroup & 0xffc0) === 0xfe80) return false;
    if ((firstGroup & 0xff00) === 0xff00) return false;
    return true;
  }
  return false;
}

function isDisallowedHostname(hostname) {
  if (!hostname) return true;
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  if (isIP(hostname) !== 0) return true;
  if (!hostname.includes(".")) return true;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    return true;
  }
  return false;
}

export function isValidArtifactOrigin(origin) {
  return typeof origin === "string" && ARTIFACT_ORIGIN_PATTERN.test(origin.replace(/\/+$/, ""));
}

export function isAllowedRequestUrl(rawUrl, options) {
  if (typeof rawUrl !== "string" || !rawUrl) {
    return { allowed: false, kind: "blocked", reason: "empty_url" };
  }
  if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || rawUrl === "about:blank") {
    return { allowed: true, kind: "internal" };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, kind: "blocked", reason: "invalid_url" };
  }

  const artifactOrigin = String(options.artifactOrigin ?? "").replace(/\/+$/, "");
  if (artifactOrigin && parsed.origin === artifactOrigin) {
    return { allowed: true, kind: "artifact", pathname: parsed.pathname };
  }

  const hostOrigin = String(options.hostOrigin ?? "").replace(/\/+$/, "");
  if (hostOrigin && parsed.origin === hostOrigin) {
    return { allowed: true, kind: "host", pathname: parsed.pathname };
  }

  if (parsed.protocol !== "https:") {
    return { allowed: false, kind: "blocked", reason: "non_https" };
  }
  if (parsed.port && parsed.port !== "443") {
    return { allowed: false, kind: "blocked", reason: "non_standard_port" };
  }

  const host = parsed.hostname.toLowerCase();
  if (isDisallowedHostname(host)) {
    return { allowed: false, kind: "blocked", reason: "ip_or_local_host" };
  }

  const allowedSet =
    options.allowedCdnHosts instanceof Set
      ? options.allowedCdnHosts
      : new Set((options.allowedCdnHosts ?? []).map((item) => String(item).toLowerCase()));

  if (allowedSet.has(host)) {
    return { allowed: true, kind: "cdn", hostname: host };
  }

  return { allowed: false, kind: "blocked", reason: "host_not_allowed" };
}

export function normalizeBundlePath(pathname) {
  if (typeof pathname !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const trimmed = decoded.replace(/^\/+/, "");
  if (!trimmed) return "";
  const segments = trimmed.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) return null;
  return segments.join("/");
}
