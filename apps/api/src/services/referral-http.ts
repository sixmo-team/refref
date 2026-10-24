import type { FastifyRequest, FastifyReply } from "fastify";
import { ReferralError } from "@refref/coredb";
import { SecurityError, validateProductScope } from "@refref/coredb/security";
import { z } from "zod";
export async function requireReferralJson(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return reply.code(415).send({
      success: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      statusCode: 415,
      message: "JSON content type required",
    });
  }
}
export async function authorizeReferralScope(
  request: FastifyRequest,
  productId: string,
  programId: string,
  operation: "resolve" | "purchase",
) {
  await validateProductScope(
    request.db,
    request.organization?.id,
    productId,
    programId,
  );
  const permissions = JSON.parse(request.apiKey?.permissions ?? "{}");
  const scope = request.apiKey?.metadata?.referralScope;
  if (
    !Array.isArray(permissions.referrals) ||
    !permissions.referrals.includes(operation) ||
    scope?.productId !== productId ||
    scope?.programId !== programId
  )
    throw new ReferralError(
      "FORBIDDEN",
      403,
      "Dedicated product/program referral scope required",
    );
}
export function sendReferralError(
  reply: FastifyReply,
  error: unknown,
  unexpectedStatusCode: 500 | 503 = 503,
) {
  const statusCode =
    error instanceof ReferralError || error instanceof SecurityError
      ? error.statusCode
      : error instanceof z.ZodError
        ? 400
        : unexpectedStatusCode;
  const code =
    error instanceof ReferralError
      ? error.code
      : error instanceof SecurityError
        ? "FORBIDDEN"
        : error instanceof z.ZodError
          ? "INVALID_REQUEST"
          : "REFERRAL_UNAVAILABLE";
  return reply.code(statusCode).send({
    success: false,
    message:
      error instanceof ReferralError || error instanceof SecurityError
        ? error.message
        : error instanceof z.ZodError
          ? "Invalid request body"
          : "Referral service unavailable",
    code,
    statusCode,
  });
}
