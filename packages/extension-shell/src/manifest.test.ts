import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json" with { type: "json" };

describe("extension manifest", () => {
  it("injects the API proxy bridge directly into the main world at document_start", () => {
    const bridge = manifest.content_scripts.find((entry) => entry.js?.includes("page-bridge.js"));
    expect(bridge).toBeDefined();
    expect(bridge?.world).toBe("MAIN");
    expect(bridge?.run_at).toBe("document_start");
    expect(bridge?.all_frames).toBe(true);
    expect(bridge?.match_about_blank).toBe(true);
  });

  it("registers the isolated-world content script alongside the bridge", () => {
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
