import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Path of the auth token file. The CLI generates this on first launch and the
 * extension reads it (manually pasted by the user once) to authenticate every
 * non-/health request to the local service.
 */
export function resolveTokenPath(rootDir: string): string {
  return join(rootDir, "token");
}

/**
 * Load the persisted auth token, generating one if the file is missing.
 *
 * The token has two consumers:
 * - The local service (this process) treats it as the bearer secret to expect
 *   on `Authorization: Bearer <token>`.
 * - A user, who copies it once into the extension's settings page so the
 *   extension's runtime can attach it to every outgoing request.
 *
 * We deliberately persist the value on disk (vs keeping it in-memory and
 * regenerating per launch) so that the user does not have to re-paste after
 * every service restart. The file is written 0600 to keep other local users
 * from reading it.
 */
export async function loadOrCreateToken(rootDir: string): Promise<string> {
  const path = resolveTokenPath(rootDir);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length >= 16) {
      return existing;
    }
    // Fall through to regenerate if the file is empty or implausibly short —
    // either we wrote it incorrectly in a previous version, or someone tampered.
  } catch (error) {
    if (!isNodeENOENT(error)) throw error;
  }

  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, "utf8");
  // chmod is best-effort: on Windows or filesystems without POSIX perms it
  // either no-ops or throws — neither failure should block service startup.
  try {
    await chmod(path, 0o600);
  } catch {
    /* ignore */
  }
  return token;
}

function isNodeENOENT(value: unknown): boolean {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === "ENOENT";
}
