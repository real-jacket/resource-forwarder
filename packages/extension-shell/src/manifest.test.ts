import { describe, expect, it } from "vitest";
import manifest from "../public/manifest.json" with { type: "json" };

describe("extension manifest", () => {
  it("injects the API proxy bridge into all frames", () => {
    expect(manifest.content_scripts[0]?.all_frames).toBe(true);
    expect(manifest.content_scripts[0]?.match_about_blank).toBe(true);
  });
});
