import { z } from "zod";
import { MAX_JOURNAL_LINES, SINCE_PATTERN } from "../services/SystemdService";

/**
 * POST /services/:unit/actions body. The enum is the complete allowlist of
 * verbs the agent will ever pass to systemctl.
 */
export const serviceActionSchema = z.object({
  action: z.enum(["start", "stop", "restart", "enable", "disable"]),
});

/**
 * GET /services/:unit/journal query params. Query values arrive as strings, so
 * `lines` is coerced and bounded (1..MAX) to keep journal output finite, and
 * `since` is checked against the accepted duration grammar before it can reach
 * journalctl. Defaults are applied in the handler when a param is omitted.
 */
export const serviceJournalQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(MAX_JOURNAL_LINES).optional(),
  since: z.string().regex(SINCE_PATTERN, "since must be a duration, date or keyword").optional(),
});
