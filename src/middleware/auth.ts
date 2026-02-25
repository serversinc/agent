import { jwtVerify, importSPKI } from "jose";
import config from "../config";
import type { Context, Next } from "hono";

const publicKeyPromise = importSPKI(config.PUBLIC_KEY, "EdDSA");

export async function jwtAuthMiddleware(ctx: Context, next: Next): Promise<any> {
  const authHeader = ctx.req.header("authorization");
  const timestampHeader = ctx.req.header("x-request-timestamp");

  if (!authHeader?.startsWith("Bearer ") || !timestampHeader) {
    return ctx.json({ error: "Unauthorized" }, 401);
  }

  const timestamp = Number(timestampHeader);
  const token = authHeader.slice(7);

  try {
    const publicKey = await publicKeyPromise;
    const verified = await jwtVerify(token, publicKey, {
      issuer: "serversinc/core",
      audience: `agent:${config.SERVER_ID}`,
      clockTolerance: 30, // Handles clock skew for iat/exp
    });

    // JWT must be created for this exact timestamp
    if (verified.payload.iat !== timestamp) {
      return ctx.json({ error: "Unauthorized" }, 401);
    }
  } catch (e) {
    console.error("JWT verification failed:", e);
    return ctx.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
