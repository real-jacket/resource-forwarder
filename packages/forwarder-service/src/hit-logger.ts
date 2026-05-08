import type { HitRecord } from "@resource-forwarder/shared-types";
import type { WorkspaceStorage } from "./storage.js";

export interface HitLoggerOptions {
  storage: WorkspaceStorage;
  /** Maximum batch size before forcing a flush. Defaults to 50. */
  batchSize?: number;
  /** Idle wait before flushing a non-empty buffer, ms. Defaults to 50ms. */
  flushIntervalMs?: number;
  /** Hard cap on buffered records — older entries get dropped if exceeded. */
  maxBufferedRecords?: number;
  /** Optional sink for transient errors so calls don't become unhandled rejections. */
  onError?: (error: unknown) => void;
}

/**
 * Decouples /forward responses from the latency (and failure modes) of the
 * append-only log file. The previous implementation awaited storage.appendHit
 * inside the request handler, so a slow disk added that latency to every
 * proxied response and any write error surfaced as a 5xx even though the
 * upstream call had succeeded.
 *
 * Behaviour:
 * - record(...) is synchronous: it just enqueues a record.
 * - The buffer is flushed when it reaches batchSize, when the idle timer fires,
 *   or explicitly via flush() (used during shutdown).
 * - If the buffer overflows maxBufferedRecords (process can't keep up), the
 *   oldest record is dropped — better to lose telemetry than to OOM.
 */
export class HitLogger {
  private readonly storage: WorkspaceStorage;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedRecords: number;
  private readonly onError: (error: unknown) => void;

  private buffer: Array<Omit<HitRecord, "id" | "occurredAt">> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private dropped = 0;

  constructor(options: HitLoggerOptions) {
    this.storage = options.storage;
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.maxBufferedRecords = options.maxBufferedRecords ?? 1000;
    this.onError = options.onError ?? (() => undefined);
  }

  record(entry: Omit<HitRecord, "id" | "occurredAt">): void {
    if (this.buffer.length >= this.maxBufferedRecords) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(entry);

    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      // Do not keep the event loop alive just to flush logs — let the process
      // exit gracefully when nothing else is pending. Tests reach into close()
      // to drain remaining records.
      if (typeof (this.timer as { unref?: () => void }).unref === "function") {
        (this.timer as { unref: () => void }).unref();
      }
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const batch = this.buffer;
    this.buffer = [];

    this.flushing = this.storage
      .appendHits(batch)
      .then(() => undefined)
      .catch((error) => {
        // Re-queue at the front so the next flush can retry. If this keeps
        // failing, maxBufferedRecords will eventually drop the oldest entries.
        this.buffer = [...batch, ...this.buffer];
        this.onError(error);
      })
      .finally(() => {
        this.flushing = undefined;
      });
    return this.flushing;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  /** Test helper: how many records have been dropped due to backpressure. */
  get droppedCount(): number {
    return this.dropped;
  }
}
