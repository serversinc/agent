import { z } from "zod";

export const installPackageSchema = z.object({
  package: z.string().min(1),
});
