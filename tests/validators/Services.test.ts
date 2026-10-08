import { describe, it, expect } from "vitest";
import { serviceActionSchema, serviceJournalQuerySchema } from "../../src/validators/Services";
import { isValidSince } from "../../src/services/SystemdService";

describe("serviceActionSchema", () => {
  it.each(["start", "stop", "restart", "enable", "disable"])("accepts the allowlisted action %j", action => {
    expect(serviceActionSchema.safeParse({ action }).success).toBe(true);
  });

  it.each(["mask", "reload", "kill", "START", "", "start; rm -rf /"])("rejects %j", action => {
    expect(serviceActionSchema.safeParse({ action }).success).toBe(false);
  });

  it("rejects a missing action", () => {
    expect(serviceActionSchema.safeParse({}).success).toBe(false);
  });
});

describe("serviceJournalQuerySchema", () => {
  it("coerces a string line count within bounds", () => {
    const result = serviceJournalQuerySchema.safeParse({ lines: "50" });
    expect(result.success && result.data.lines).toBe(50);
  });

  it("accepts an empty query (defaults are applied by the handler)", () => {
    const result = serviceJournalQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.lines).toBeUndefined();
  });

  it.each(["0", "1001", "-5", "1.5", "abc", ""])("rejects an out-of-bounds or non-integer line count %j", lines => {
    expect(serviceJournalQuerySchema.safeParse({ lines }).success).toBe(false);
  });

  it.each(["1h", "30min", "2 days ago", "today", "yesterday", "2026-01-01", "2026-01-01 10:30"])(
    "accepts the since value %j",
    since => {
      expect(serviceJournalQuerySchema.safeParse({ since }).success).toBe(true);
    },
  );

  it.each(["-1h", "1h; rm -rf /", "now --foo", "nonsense", "1h && id", ""])("rejects the since value %j", since => {
    expect(serviceJournalQuerySchema.safeParse({ since }).success).toBe(false);
  });
});

describe("isValidSince", () => {
  it.each(["1h", "15m", "7d", "1 week ago", "now"])("accepts %j", value => {
    expect(isValidSince(value)).toBe(true);
  });

  it.each(["-1h", "1h; id", 5, null, undefined, "1h\n2h"])("rejects %j", value => {
    expect(isValidSince(value as unknown)).toBe(false);
  });
});
