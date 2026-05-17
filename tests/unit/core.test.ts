import { describe, it, expect } from "vitest";
import { EventEmitter } from "../../packages/core/src/internal/event-emitter.js";
import { ZerithDBError, ErrorCode } from "../../packages/errors/src/index.js";

// ─── EventEmitter ─────────────────────────────────────────────────────────────

type TestEvents = {
  data: { value: number };
  error: { message: string };
  done: undefined;
};

describe("EventEmitter", () => {
  it("should emit events to registered listeners", () => {
    const emitter = new EventEmitter<TestEvents>();
    const received: number[] = [];
    emitter.on("data", ({ value }) => received.push(value));
    emitter.emit("data", { value: 42 });
    emitter.emit("data", { value: 99 });
    expect(received).toEqual([42, 99]);
  });

  it("should support multiple listeners for the same event", () => {
    const emitter = new EventEmitter<TestEvents>();
    let count = 0;
    emitter.on("data", () => count++);
    emitter.on("data", () => count++);
    emitter.emit("data", { value: 1 });
    expect(count).toBe(2);
  });

  it("once() should fire only once", () => {
    const emitter = new EventEmitter<TestEvents>();
    let count = 0;
    emitter.once("data", () => count++);
    emitter.emit("data", { value: 1 });
    emitter.emit("data", { value: 2 });
    expect(count).toBe(1);
  });

  it("off() should remove a specific listener", () => {
    const emitter = new EventEmitter<TestEvents>();
    let count = 0;
    const handler = () => count++;
    emitter.on("data", handler);
    emitter.off("data", handler);
    emitter.emit("data", { value: 1 });
    expect(count).toBe(0);
  });

  it("removeAllListeners() should clear all listeners for an event", () => {
    const emitter = new EventEmitter<TestEvents>();
    let count = 0;
    emitter.on("data", () => count++);
    emitter.on("data", () => count++);
    emitter.removeAllListeners("data");
    emitter.emit("data", { value: 1 });
    expect(count).toBe(0);
  });

  it("should not throw when emitting an event with no listeners", () => {
    const emitter = new EventEmitter<TestEvents>();
    expect(() => emitter.emit("data", { value: 1 })).not.toThrow();
  });
});

// ─── ZerithDBError ────────────────────────────────────────────────────────────

describe("ZerithDBError", () => {
  it("should have correct name and code", () => {
    const err = new ZerithDBError(ErrorCode.DB_WRITE_FAILED, "write failed");
    expect(err.name).toBe("ZerithDBError");
    expect(err.code).toBe(ErrorCode.DB_WRITE_FAILED);
    expect(err.message).toBe("write failed");
  });

  it("should be instanceof Error and ZerithDBError", () => {
    const err = new ZerithDBError(ErrorCode.AUTH_KEY_NOT_FOUND, "no key");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ZerithDBError);
  });

  it("should support cause chaining", () => {
    const cause = new TypeError("original");
    const err = new ZerithDBError(ErrorCode.DB_READ_FAILED, "read failed", { cause });
    expect((err.cause as Error).message).toBe("original");
  });

  it("toString() should include code and message", () => {
    const err = new ZerithDBError(ErrorCode.SYNC_APPLY_FAILED, "sync broke");
    expect(err.toString()).toContain("SYNC_APPLY_FAILED");
    expect(err.toString()).toContain("sync broke");
  });
});
