import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  resolveReferralRequestSchema,
  referralCodeResolutionSchema,
} from "@refref/types";
import { ReferralError, resolveReferralCode } from "@refref/coredb";
import {
  authorizeReferralScope,
  sendReferralError,
  requireReferralJson,
} from "../../../services/referral-http.js";
import { normalizeCode, isRefcodeFormat } from "@refref/utils";
export default async function resolveRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/resolve",
    {
      bodyLimit: 256 * 1024,
      onRequest: [fastify.authenticateApiKey, requireReferralJson],
      schema: {
        body: z.toJSONSchema(resolveReferralRequestSchema, {
          io: "input",
          target: "draft-7",
        }),
        response: {
          200: z.toJSONSchema(referralCodeResolutionSchema, {
            target: "draft-7",
          }),
        },
      },
      validatorCompiler: () => (data) => {
        const result = resolveReferralRequestSchema.safeParse(data);
        return result.success
          ? { value: result.data }
          : { error: result.error };
      },
    },
    async (request, reply) => {
      try {
        const input = resolveReferralRequestSchema.parse(request.body);
        input.code = normalizeCode(input.code);
        if (!isRefcodeFormat(input.code))
          throw new ReferralError(
            "INVALID_REQUEST",
            400,
            "Invalid referral code format",
          );
        await authorizeReferralScope(
          request,
          input.productId,
          input.programId,
          "resolve",
        );
        return reply.send(await resolveReferralCode(request.db, input));
      } catch (error) {
        request.log.warn(
          { code: error instanceof Error ? error.name : "unknown" },
          "Referral resolution failed",
        );
        return sendReferralError(reply, error);
      }
    },
  );
}
