import { describe, it, expect } from "vitest";
import { createImageSchema } from "../../src/validators/Images";

describe("createImageSchema", () => {
  const valid = {
    name: "owner/repo",
    tag: "a1b2c3d",
    applicationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    token: "gh_token",
  };

  it("accepts a valid payload", () => {
    expect(createImageSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    "owner",
    "owner/repo/extra",
    "owner//repo",
    "owner/../repo",
    "owner/repo; rm -rf /",
  ])("rejects a malformed name %j", name => {
    expect(createImageSchema.safeParse({ ...valid, name }).success).toBe(false);
  });

  it.each(["not-a-sha", "abc", "g1b2c3d", "abc123; rm -rf /"])("rejects a non-commit-sha tag %j", tag => {
    expect(createImageSchema.safeParse({ ...valid, tag }).success).toBe(false);
  });

  it.each(["../../etc/passwd", "app_1", "not-a-ulid"])("rejects a non-ULID applicationId %j", applicationId => {
    expect(createImageSchema.safeParse({ ...valid, applicationId }).success).toBe(false);
  });

  it("rejects an empty token", () => {
    expect(createImageSchema.safeParse({ ...valid, token: "" }).success).toBe(false);
  });

  it("accepts a payload without buildArgs", () => {
    expect(createImageSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts valid buildArgs", () => {
    const result = createImageSchema.safeParse({ ...valid, buildArgs: { NODE_ENV: "production", API_URL: "https://example.com" } });
    expect(result.success).toBe(true);
  });

  it.each(["1BAD", "bad-key", "bad key", ""])("rejects a buildArgs key that isn't a valid identifier %j", key => {
    expect(createImageSchema.safeParse({ ...valid, buildArgs: { [key]: "value" } }).success).toBe(false);
  });
});
