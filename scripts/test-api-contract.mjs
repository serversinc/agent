import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const project = process.env.API_PROJECT_DIR;
if (!project) {
  console.log("SKIP API parser interoperability: set API_PROJECT_DIR to the canonical-heartbeat checkout.");
  process.exit(0);
}

const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const generated = spawnSync("node", [resolve(here, "generate-producer-observations.mjs")], { encoding: "utf8", env: process.env });
if (generated.error) throw generated.error;
if (generated.status !== 0) {
  process.stderr.write(generated.stderr || "Producer fixture generation failed.\n");
  process.exit(generated.status ?? 1);
}

const result = spawnSync("php", [
  resolve(here, "api-parser-interop.php"),
  resolve(project),
  resolve(here, "../tests/fixtures/server-observations"),
], {
  stdio: "inherit",
  env: { ...process.env, PRODUCER_OBSERVATIONS_JSON: generated.stdout.trim() },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
