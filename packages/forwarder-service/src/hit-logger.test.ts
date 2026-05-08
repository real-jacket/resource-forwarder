import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HitLogger } from "./hit-logger.js";

interface FakeStorage {
  appendHits: ReturnType<typeof vi.fn>;
  records: Array<{ requestUrl: string }>;
}

function createStorage(): FakeStorage {
  const records: Array<{ requestUrl: string }> = [];
  return {
    records,
    appendHits: vi.fn(async (batch: Array<{ requestUrl: string }>) => {
      records.push(...batch);
      return batch.map((b) => ({ ...b, id: "id", occurredAt: new Date().toISOString() }));
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HitLogger", () => {
  it("flushes when the batch size threshold is reached", async () => {
    const storage = createStorage();
    const logger = new HitLogger({
      storage: storage as unknown as Parameters<typeof HitLogger>[0]["storage"],
      batchSize: 3,
      flushIntervalMs: 10_000,
    });
    for (let i = 0; i < 3; i += 1) {
      logger.record({
        requestUrl: `u${i}`,
        ruleId: "r",
        target: "t",
        durationMs: 0,
        outcome: "matched",
        method: "GET",
        resourceType: "fetch",
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    await logger.flush();
    expect(storage.appendHits).toHaveBeenCalledTimes(1);
    expect(storage.records).toHaveLength(3);
  });

  it("flushes on the idle timer when below the batch threshold", async () => {
    const storage = createStorage();
    const logger = new HitLogger({
      storage: storage as unknown as Parameters<typeof HitLogger>[0]["storage"],
      batchSize: 100,
      flushIntervalMs: 50,
    });
    logger.record({ requestUrl: "u", ruleId: "r", target: "t", durationMs: 0, outcome: "matched", method: "GET", resourceType: "fetch" });
    await vi.advanceTimersByTimeAsync(60);
    await logger.flush();
    expect(storage.appendHits).toHaveBeenCalledTimes(1);
  });

  it("drops the oldest records when the buffer overflows the cap", async () => {
    const storage = createStorage();
    const logger = new HitLogger({
      storage: storage as unknown as Parameters<typeof HitLogger>[0]["storage"],
      batchSize: 1000,
      flushIntervalMs: 10_000,
      maxBufferedRecords: 2,
    });
    logger.record({ requestUrl: "first", ruleId: "r", target: "t", durationMs: 0, outcome: "matched", method: "GET", resourceType: "fetch" });
    logger.record({ requestUrl: "second", ruleId: "r", target: "t", durationMs: 0, outcome: "matched", method: "GET", resourceType: "fetch" });
    logger.record({ requestUrl: "third", ruleId: "r", target: "t", durationMs: 0, outcome: "matched", method: "GET", resourceType: "fetch" });
    expect(logger.droppedCount).toBe(1);
    await logger.close();
    expect(storage.records.map((r) => r.requestUrl)).toEqual(["second", "third"]);
  });

  it("re-queues the batch and reports the error if appendHits throws", async () => {
    // Use real timers for this test: fake timers stub setImmediate, which
    // breaks the microtask drain we'd otherwise need to observe the .catch
    // handler running. The HitLogger triggers flush synchronously when the
    // batch threshold is hit, so real timers don't add measurable latency.
    vi.useRealTimers();

    const storage = createStorage();
    storage.appendHits.mockRejectedValueOnce(new Error("disk full"));
    const errors: unknown[] = [];
    const logger = new HitLogger({
      storage: storage as unknown as Parameters<typeof HitLogger>[0]["storage"],
      batchSize: 1,
      flushIntervalMs: 10_000,
      onError: (err) => errors.push(err),
    });
    logger.record({ requestUrl: "first", ruleId: "r", target: "t", durationMs: 0, outcome: "matched", method: "GET", resourceType: "fetch" });
    // Wait for the rejected appendHits → .catch → buffer restore chain.
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toHaveLength(1);
    // Next flush should retry — the record is still queued.
    await logger.flush();
    expect(storage.records.map((r) => r.requestUrl)).toEqual(["first"]);
  });
});
