import type { MatchCondition } from "@resource-forwarder/shared-types";

/**
 * Convert a path glob into a regex source string suitable for `new RegExp(\`^${...}$\`)`.
 *
 * @deprecated The `*` mapping here (`[^?]*`) is wider than what callers
 * usually want — it lets a single `*` cross path segments. New code should
 * use {@link globToPathRegexSource} instead, which keeps `*` confined to a
 * single segment. This function is preserved for the DNR `regexFilter`
 * pipeline, which historically depended on the looser semantics; aligning it
 * is tracked as a separate change so it does not block the auth/observability
 * work.
 *
 * Glob semantics (intentionally a subset of POSIX/picomatch):
 *   `**`  → `.*`        (zero or more of anything, INCLUDING `/`)
 *   `*`   → `[^?]*`     (zero or more characters, excluding the query separator)
 *   `?`   → `[^/]`      (single non-slash character)
 *   else  → escaped literal
 *
 * The returned source is always normalised to begin with `/` so callers can
 * concatenate it directly after a host pattern.
 */
export function globToRegexSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const current = glob[index];
    const next = glob[index + 1];
    if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (current === "*") {
      source += "[^?]*";
      continue;
    }
    if (current === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(current);
  }

  if (!source.startsWith("/")) source = `/${source}`;
  return source;
}

/**
 * Convert a path glob into a regex source string for matching JUST the path
 * portion of a URL. Unlike {@link globToRegexSource}, a single `*` does not
 * cross `/` — the user-friendly "match anything in this segment" semantics
 * the matcher cache uses for runtime rule selection.
 *
 *   `**`  → `.*`
 *   `*`   → `[^/]*`
 *   `?`   → `[^/]`
 *   else  → escaped literal
 *
 * The output is NOT prefixed with `/` because callers compose it directly
 * (e.g. `new RegExp('^' + source + '$')` against `URL.pathname`, which always
 * starts with `/`).
 */
export function globToPathRegexSource(glob: string): string {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const current = glob[i];
    if (current === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 2;
      continue;
    }
    if (current === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (current === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    source += escapeRegex(current);
    i += 1;
  }
  return source;
}

/**
 * Convert a path glob to a Chrome DNR `urlFilter` string, or return null when
 * the glob contains characters DNR's urlFilter syntax cannot represent (e.g.
 * `?`, `[`, `]`, `{`, `}`, `(`, `)`).
 *
 * Mapping:
 *   `**`    → `*`     (match anything)
 *   `*`     → `*`     (match anything except `?`)
 *   `.`     → `.`     (literal — urlFilter treats `.` as literal)
 *   other   → literal
 *
 * The returned filter is anchored at the beginning of the URL (`|*://*…`) so
 * it matches any scheme and host but starts at the path boundary.
 */
export function globToUrlFilter(glob: string): string | null {
  if (/[?[\]{}()]/.test(glob)) return null;

  let filter = glob
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "*")
    .replace(/\0/g, "*");

  // Collapse consecutive wildcards — Chrome rejects redundant ones.
  filter = filter.replace(/\*{2,}/g, "*");

  if (!filter.startsWith("/")) filter = `/${filter}`;
  return `|*://*${filter}`;
}

/** Escape a literal string for safe inclusion in a regex pattern. */
export function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

/**
 * Build the host portion of a DNR regexFilter. When all hosts are wildcards
 * (or the wildcard `*` is present) `wildcardSource` is returned so callers can
 * pick the most permissive bracket (`.*` for general regex matching, `[^/]+`
 * for a single host segment).
 */
export function buildHostRegexSource(hosts: string[], wildcardSource: string): string {
  if (hosts.length === 0 || hosts.includes("*")) return wildcardSource;
  return `(?:${hosts.map((host) => escapeRegex(host).replace(/\*/g, "[^.]+")).join("|")})`;
}

/**
 * FNV-1a-derived stable positive hash. Used to derive deterministic numeric
 * ids for Chrome DNR rules (which require non-zero positive integers) from
 * string ids that the rest of the codebase uses.
 */
export function stablePositiveHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1000000000 || 1;
}

/**
 * Build the regex filter portion of a DNR condition for a rule's match
 * spec. Uses globToRegexSource for the path component and buildHostRegexSource
 * for the host component.
 */
export function buildRegexFilter(match: MatchCondition): string {
  const hostPattern = buildHostRegexSource(match.host, ".*");
  const pathPattern = globToRegexSource(match.pathGlob || "**");
  return `^https?:\\/\\/${hostPattern}${pathPattern}(?:[?#].*)?$`;
}
