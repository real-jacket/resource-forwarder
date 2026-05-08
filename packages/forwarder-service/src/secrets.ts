import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

/**
 * Forward profiles routinely carry credentials in `headers` (Authorization,
 * cookies pasted by hand, internal API tokens). Persisting them in plaintext
 * inside `workspace.json` was a footgun: a casual `cat workspace.json`,
 * accidental upload to a chat thread, or `tar -czf backup` would leak them.
 *
 * SecretsManager keeps the same observable behaviour for in-process callers
 * (rules read back identical headers), but on disk those values live in a
 * separate AES-256-GCM encrypted file (`secrets.json`). The encryption key is
 * derived from a randomly-generated `secret.key` so the workspace file alone
 * is meaningless without it.
 *
 * Threat model: this defends against accidental disclosure of workspace
 * snapshots (sharing, backups, screenshots). It is NOT a defence against an
 * attacker with arbitrary read access to `rootDir` — anyone who can read
 * secrets.json AND secret.key can recover the cleartext.
 */
export class SecretsManager {
  private readonly secretsFile: string;
  private readonly keyFile: string;
  private cache = new Map<string, string>();
  private loaded = false;
  private cachedKey: Buffer | undefined;

  constructor(rootDir: string) {
    this.secretsFile = join(rootDir, "secrets.json");
    this.keyFile = join(rootDir, "secret.key");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.ensureKey();
    try {
      const raw = await readFile(this.secretsFile, "utf8");
      const parsed = JSON.parse(raw) as { entries?: Record<string, string> };
      const key = await this.ensureKey();
      this.cache = decryptEntries(parsed.entries ?? {}, key);
    } catch (error) {
      if (!isENOENT(error)) {
        // Don't swallow corruption silently — but also don't 5xx the service.
        // Log to stderr; the user can re-enter their secrets.
        // eslint-disable-next-line no-console
        console.error(`[forwarder-service] secrets.json unreadable; treating as empty.`, error);
      }
      this.cache = new Map();
    }
    this.loaded = true;
  }

  /**
   * Walk the workspace, replacing each header value in
   * `target.forwardProfile.headers` with an opaque `secret:<id>` ref. Returns
   * a NEW workspace object so callers don't accidentally mutate their input.
   * Side-effects: updates the in-memory secret cache and persists secrets.json.
   */
  async redactWorkspace(workspace: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    await this.load();
    const next: WorkspaceSnapshot = { ...workspace, rules: [] };
    let changed = false;
    next.rules = workspace.rules.map((rule) => redactRule(rule, this.cache, () => { changed = true; }));
    if (changed) await this.persist();
    return next;
  }

  /** Reverse of redactWorkspace: replace `secret:<id>` refs with cleartext. */
  async hydrateWorkspace(workspace: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    await this.load();
    return {
      ...workspace,
      rules: workspace.rules.map((rule) => hydrateRule(rule, this.cache)),
    };
  }

  private async ensureKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    try {
      const raw = await readFile(this.keyFile);
      // The on-disk key is a 32-byte salt + 32-byte randomness payload, base64
      // encoded. We derive the AES key with scrypt to keep brute-force costly
      // even if the key file is exfiltrated together with secrets.json.
      const decoded = Buffer.from(raw.toString("utf8").trim(), "base64");
      if (decoded.length !== 64) throw new Error("secret.key is malformed");
      const salt = decoded.subarray(0, 32);
      const material = decoded.subarray(32);
      this.cachedKey = scryptSync(material, salt, 32);
      return this.cachedKey;
    } catch (error) {
      if (!isENOENT(error)) throw error;
    }
    const salt = randomBytes(32);
    const material = randomBytes(32);
    const combined = Buffer.concat([salt, material]).toString("base64");
    await mkdir(dirname(this.keyFile), { recursive: true });
    await writeFile(this.keyFile, `${combined}\n`, "utf8");
    try { await chmod(this.keyFile, 0o600); } catch { /* best-effort */ }
    this.cachedKey = scryptSync(material, salt, 32);
    return this.cachedKey;
  }

  private async persist(): Promise<void> {
    const key = await this.ensureKey();
    const entries: Record<string, string> = {};
    for (const [id, value] of this.cache) {
      entries[id] = encryptValue(value, key);
    }
    await mkdir(dirname(this.secretsFile), { recursive: true });
    const tmp = `${this.secretsFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ entries }, null, 2), "utf8");
    // Atomic replace — same pattern as workspace.json so a crash mid-write
    // never leaves a half-written secrets file.
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.secretsFile);
    try { await chmod(this.secretsFile, 0o600); } catch { /* best-effort */ }
  }
}

const SECRET_REF_PREFIX = "secret:";

function redactRule(rule: Rule, cache: Map<string, string>, markChanged: () => void): Rule {
  const profile = rule.target.forwardProfile;
  if (!profile?.headers) return rule;
  const redactedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(profile.headers)) {
    if (value.startsWith(SECRET_REF_PREFIX)) {
      // Already redacted (e.g. round-trip of a previously persisted snapshot).
      redactedHeaders[name] = value;
      continue;
    }
    if (!isSensitiveHeaderName(name)) {
      redactedHeaders[name] = value;
      continue;
    }
    const id = `${rule.id}:${name.toLowerCase()}`;
    cache.set(id, value);
    redactedHeaders[name] = `${SECRET_REF_PREFIX}${id}`;
    markChanged();
  }
  return {
    ...rule,
    target: { ...rule.target, forwardProfile: { ...profile, headers: redactedHeaders } },
  };
}

function hydrateRule(rule: Rule, cache: Map<string, string>): Rule {
  const profile = rule.target.forwardProfile;
  if (!profile?.headers) return rule;
  const hydrated: Record<string, string> = {};
  for (const [name, value] of Object.entries(profile.headers)) {
    if (value.startsWith(SECRET_REF_PREFIX)) {
      const id = value.slice(SECRET_REF_PREFIX.length);
      hydrated[name] = cache.get(id) ?? "";
      continue;
    }
    hydrated[name] = value;
  }
  return {
    ...rule,
    target: { ...rule.target, forwardProfile: { ...profile, headers: hydrated } },
  };
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}

function encryptValue(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptValue(value: string, key: Buffer): string {
  const buf = Buffer.from(value, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

function decryptEntries(entries: Record<string, string>, key: Buffer): Map<string, string> {
  const cache = new Map<string, string>();
  for (const [id, encrypted] of Object.entries(entries)) {
    try {
      cache.set(id, decryptValue(encrypted, key));
    } catch {
      // A failed decrypt usually means key/secrets drift (e.g. user copied
      // secrets.json without secret.key). Skip the entry rather than crashing
      // — the route handler will see an empty header and the user can re-enter.
    }
  }
  return cache;
}

function isENOENT(value: unknown): boolean {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === "ENOENT";
}
