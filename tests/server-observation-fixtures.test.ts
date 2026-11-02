import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const directory = join(process.cwd(), "tests/fixtures/server-observations");

describe("shared server observation fixtures", () => {
  it("matches the vendored source hashes and exact fixture inventory", () => {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as {
      source_repository: string;
      source_revision: string;
      source_path: string;
      files: Record<string, string>;
    };
    expect(manifest.source_repository).toBe("serversinc/api");
    expect(manifest.source_revision).toBe("1cd615550a9d503d6a6f05718a23a43ee15a8c7e");
    expect(manifest.source_path).toBe("tests/Fixtures/server-observations");
    const fixtureFiles = readdirSync(directory).filter((file) => file.endsWith(".json") && file !== "manifest.json").sort();
    expect(fixtureFiles).toEqual(Object.keys(manifest.files).sort());
    for (const file of fixtureFiles) {
      const actual = createHash("sha256").update(readFileSync(join(directory, file))).digest("hex");
      expect(actual, `${file} SHA-256`).toBe(manifest.files[file]);
    }
  });

  it("contains all shared examples with a request body and expected parser outcome", () => {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".json") && name !== "manifest.json")) {
      const example = JSON.parse(readFileSync(join(directory, file), "utf8"));
      expect(example).toHaveProperty("body");
      expect(example).toHaveProperty("expected");
    }
  });
});
