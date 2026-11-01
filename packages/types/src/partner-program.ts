import { z } from "zod";

export const payoutRecipientInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    details: z.string().trim().min(1).max(1000),
  })
  .strict();
export type PayoutRecipientInput = z.infer<typeof payoutRecipientInputSchema>;
export type PayoutRecipientSnapshot = PayoutRecipientInput & {
  providedBy: string;
  providedAt: string;
};

export const partnerRulesBodySchema = z.string().trim().min(200).max(30_000);
