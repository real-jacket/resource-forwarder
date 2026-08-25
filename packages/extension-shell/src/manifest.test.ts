import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json" with { type: "json" };

describe("extension manifest", () => {
  it("keeps page-bridge.js out of static content scripts", () => {
    const bridge = manifest.content_scripts.find((entry) => entry.js?.includes("page-bridge.js"));
    expect(bridge).toBeUndefined();
  });

  it("registers the isolated-world content script at document_start", () => {
    const isolated = manifest.content_scripts.find((entry) => entry.js?.includes("content-script.js"));
    expect(isolated).toBeDefined();
    expect(isolated?.run_at).toBe("document_start");
    expect(isolated?.all_frames).toBe(true);
  });

  it("does not expose page-bridge.js as a web-accessible resource", () => {
    // Once the bridge is a main-world content script the script-tag injection
    // path is gone, and we don't want random pages fetching the source.
    for (const entry of manifest.web_accessible_resources ?? []) {
      expect(entry.resources).not.toContain("page-bridge.js");
    }
  });

  it("declares the alarms permission used for worker reconciliation", () => {
    expect(manifest.permissions).toContain("alarms");
  });
});
