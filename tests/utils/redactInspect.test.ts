import { describe, it, expect } from "vitest";
import { redactInspect } from "../../src/utils/redactInspect";

describe("redactInspect", () => {
  it("replaces env values while keeping the keys", () => {
    const inspect = { Id: "abc123", Config: { Env: ["A=secret", "B=two=three"] } };

    expect(redactInspect(inspect)).toEqual({
      Id: "abc123",
      Config: { Env: ["A=[redacted]", "B=[redacted]"] },
    });
  });

  it("redacts a key-only entry and leaves an empty entry empty", () => {
    const inspect = { Config: { Env: ["FLAG", ""] } };

    expect(redactInspect(inspect)).toEqual({ Config: { Env: ["FLAG=[redacted]", ""] } });
  });

  it("returns an inspect with an empty env array unchanged", () => {
    const inspect = { Id: "abc123", Config: { Env: [], Image: "nginx:latest" } };

    expect(redactInspect(inspect)).toEqual({ Id: "abc123", Config: { Env: [], Image: "nginx:latest" } });
  });

  it("returns an inspect without Env unchanged", () => {
    const inspect = { Id: "abc123", Config: { Image: "nginx:latest" } };

    expect(redactInspect(inspect)).toEqual({ Id: "abc123", Config: { Image: "nginx:latest" } });
  });

  it("returns an inspect without Config unchanged", () => {
    const inspect = { Id: "abc123", Name: "/app-1" };

    expect(redactInspect(inspect)).toEqual({ Id: "abc123", Name: "/app-1" });
  });

  it("does not mutate the input", () => {
    const inspect = { Config: { Env: ["SECRET=value"] } };

    redactInspect(inspect);

    expect(inspect.Config.Env).toEqual(["SECRET=value"]);
  });
});
