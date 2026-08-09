import { z } from "zod";

export const toggleSchema = z.object({
  enabled: z.boolean(),
});

export const firewallPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
});
