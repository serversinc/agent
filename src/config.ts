import { z } from "zod";
import dotenv from "dotenv";
import { readFileSync } from "fs";

dotenv.config();

// Define the schema with validation rules
const configSchema = z.object({
  PORT: z
    .string()
    .default("3000")
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive().max(65535)),

  CORE_URL: z.string().url("CORE_URL must be a valid URL").min(1, "CORE_URL is required"),

  PUBLIC_KEY_PATH: z.string().min(1, "PUBLIC_KEY_PATH is required"),

  SECRET_KEY: z.string().min(32),

  SERVER_ID: z.string().ulid(),

  DOCKER_SOCKET: z
    .string()
    .default("/var/run/docker.sock")
    .refine(val => val.startsWith("/") || val.startsWith("unix://") || val.startsWith("tcp://"), "DOCKER_SOCKET must be a valid socket path or URL"),

  HTTP_TIMEOUT: z
    .string()
    .default("5000")
    .transform(val => parseInt(val, 10))
    .pipe(z.number().int().positive().max(30000)),

  LOGGER_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  LOGGER_PRETTY: z
    .string()
    .default("false")
    .transform(val => val === "true")
    .pipe(z.boolean()),
});

// Infer the TypeScript type from the schema
export type AppConfig = Omit<z.infer<typeof configSchema>, 'PUBLIC_KEY_PATH'> & { PUBLIC_KEY: string };

// Parse and validate environment variables
function loadConfig(): AppConfig {
  try {
    const rawConfig = configSchema.parse({
      PORT: process.env.PORT,
      CORE_URL: process.env.CORE_URL,
      PUBLIC_KEY_PATH: process.env.PUBLIC_KEY_PATH,
      SECRET_KEY: process.env.SECRET_KEY,
      SERVER_ID: process.env.SERVER_ID,
      DOCKER_SOCKET: process.env.DOCKER_SECRET,
      HTTP_TIMEOUT: process.env.HTTP_TIMEOUT,
      LOGGER_LEVEL: process.env.LOGGER_LEVEL,
      LOGGER_PRETTY: process.env.LOGGER_PRETTY
    });

    // Load the public key file
    const publicKey = readFileSync(rawConfig.PUBLIC_KEY_PATH, "utf8");

    // Validate it's a valid PEM key
    if (!/-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/.test(publicKey)) {
      throw new Error("PUBLIC_KEY file must contain a valid PEM public key");
    }

    return {
      ...rawConfig,
      PUBLIC_KEY: publicKey,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map(err => `  - ${err.path.join(".")}: ${err.message}`).join("\n");

      throw new Error(`Configuration validation failed:\n${errorMessages}\n\nPlease check your .env file.`);
    }
    throw error;
  }
}

export const config = loadConfig();

export default config;
