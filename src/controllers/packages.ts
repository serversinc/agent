import { Context } from "hono";
import { PackageService } from "../services/PackageService";
import { handleError } from "../utils/error";

export function createPackageHandlers(packageService: PackageService) {
  if (!packageService) throw new Error("Package service is required");

  async function install(ctx: Context) {
    try {
      const { package: name } = await ctx.req.json<{ package: string }>();
      const result = await packageService.install(name);
      return ctx.json(result);
    } catch (err) {
      const error = err as Error;
      if (error.message?.startsWith("Invalid package name")) {
        return ctx.json({ error: error.message }, 400);
      }
      return handleError(ctx, err, "Package", "install package");
    }
  }

  return { install };
}
