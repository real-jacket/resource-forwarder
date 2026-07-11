import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { ForwardRequestPayload, RuleBinding } from "@resource-forwarder/shared-types";
import {
  buildForwardResponseHeaders,
  buildForwardTargetUrl,
  createRequestContext,
  executeForward,
  STREAMING_UNSUPPORTED,
} from "@resource-forwarder/forward-core";

const MAX_FORWARDABLE_BODY_BYTES = 4 * 1024 * 1024;

export { buildForwardResponseHeaders, buildForwardTargetUrl, createRequestContext, STREAMING_UNSUPPORTED };

export async function forwardThroughRule(binding: RuleBinding, payload: ForwardRequestPayload) {
  return executeForward(binding, payload, { mockFile: readNodeMockFile });
}

async function readNodeMockFile(configuredPath: string): Promise<{ value: unknown; displayName: string }> {
  const filePath = resolve(configuredPath);
  if (extname(filePath).toLowerCase() !== ".json") {
    throw new Error("Mock response files must use the .json extension.");
  }
  const displayName = basename(filePath);
  let file: Buffer;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not-a-file");
    if (fileStat.size > MAX_FORWARDABLE_BODY_BYTES) throw new Error("file-too-large");
    file = await readFile(filePath);
  } catch (error) {
    if (error instanceof Error && error.message === "file-too-large") {
      throw new Error(`Mock JSON file ${displayName} exceeds ${MAX_FORWARDABLE_BODY_BYTES} bytes.`);
    }
    throw new Error(`Unable to read mock JSON file ${displayName}.`);
  }
  if (file.byteLength > MAX_FORWARDABLE_BODY_BYTES) {
    throw new Error(`Mock JSON file exceeds ${MAX_FORWARDABLE_BODY_BYTES} bytes.`);
  }
  try {
    return { value: JSON.parse(file.toString("utf8")), displayName };
  } catch {
    throw new Error("Mock response file is not valid JSON.");
  }
}
