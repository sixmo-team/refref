import { z } from "zod";
import { createTRPCRouter, adminProcedure } from "@/server/api/trpc";
import { schema } from "@/server/db";
const { productSecrets } = schema;
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { validateProductScope } from "@refref/coredb/security";

export const productSecretsRouter = createTRPCRouter({
  get: adminProcedure
    .input(
      z
        .object({
          productId: z.string().min(1),
          scope: z
            .object({
              userId: z.string().min(1),
              organizationId: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      if (
        input.scope.userId !== ctx.userId ||
        input.scope.organizationId !== ctx.activeOrganizationId
      )
        throw new TRPCError({ code: "FORBIDDEN" });
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      const [secrets] = await ctx.db
        .select()
        .from(productSecrets)
        .where(eq(productSecrets.productId, input.productId))
        .limit(1);

      if (!secrets) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No secrets found for this product",
        });
      }

      // Return client ID and client secret
      return {
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
      };
    }),
});
