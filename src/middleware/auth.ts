import { jwtVerify, importSPKI } from "jose";
import config from "../config";
import type { Context, Next } from "hono";
import crypto from "crypto";

const CLOCK_SKEW_SECONDS = 30;

const publicKeyPromise = importSPKI(config.PUBLIC_KEY, "EdDSA");

export async function jwtAuthMiddleware(ctx: Context, next: Next): Promise<any> {
  const authHeader = ctx.req.header("authorization");
  const timestampHeader = ctx.req.header("x-request-timestamp");

  if (!authHeader?.startsWith("Bearer ")) {
    return ctx.json({ error: "Unauthorized" }, 401);
  }

  if (!timestampHeader || isNaN(Number(timestampHeader))) {
    return ctx.json({ error: "Invalid timestamp" }, 401);
  }

  const timestamp = Number(timestampHeader);
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > CLOCK_SKEW_SECONDS) {
    return ctx.json({ error: "Expired request" }, 401);
  }

  const token = authHeader.slice(7);

  let verified;

  try {
    const publicKey = await publicKeyPromise;

    verified = await jwtVerify(token, publicKey, {
      issuer: "serversinc",
      audience: `agent:${config.SERVER_ID}`,
    });
  } catch {
    return ctx.json({ error: "Unauthorized" }, 401);
  }

  const payload = verified.payload as {
    ts: number;
    body_hash: string;
  };

  if (Number(payload.ts) !== timestamp) {
    return ctx.json({ error: "Invalid timestamp" }, 401);
  }

  if (!payload.body_hash) {
    return ctx.json({ error: "Malformed request body" }, 401);
  }

  const rawBody = await ctx.req.raw.clone().text();
  const hash = crypto.createHash("sha256").update(rawBody).digest("hex");

  if (payload.body_hash !== hash) {
    return ctx.json({ error: "Malformed request body" }, 401);
  }

  await next();
}
