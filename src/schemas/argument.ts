import { z } from "zod";
import { uuidSchema, stanceEnum } from "./common.js";

export const argumentResponse = z.object({
  id: uuidSchema,
  claim_id: uuidSchema,
  stance: stanceEnum,
  content: z.string(),
  lean_check_id: uuidSchema.nullable(),
  evidence_sent_to_steward: z.array(z.string()),
  created_by: z.string(),
  created_at: z.string(),
});
