import { z } from "zod";

export const createVolumeSchema = z.object({
  name: z.string(),
  driver: z.string().optional(),
  labels: z.record(z.string()).optional(),
});
