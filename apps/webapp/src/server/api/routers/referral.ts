import {
  createTRPCRouter,
  protectedProcedure,
  adminProcedure,
} from "@/server/api/trpc";
import { SignJWT } from "jose";
import { env } from "@/env";
import type { JwtPayloadType } from "@refref/types";
import { eq, and } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { TRPCError } from "@trpc/server";
const { user: userTable } = schema;
import { z } from "zod";
import { validateProductScope } from "@refref/coredb/security";

export const referralRouter = createTRPCRouter({
  setCodeActive: adminProcedure
    .input(
      z
        .object({
          productId: z.string().min(1).max(200),
          codeId: z.string().min(1).max(200),
          active: z.boolean(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.productId,
      );
      const [updated] = await ctx.db
        .update(schema.refcode)
        .set({ isActive: input.active, updatedAt: new Date() })
        .where(
          and(
            eq(schema.refcode.id, input.codeId),
            eq(schema.refcode.productId, input.productId),
          ),
        )
        .returning({
          id: schema.refcode.id,
          isActive: schema.refcode.isActive,
        });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return updated;
    }),
  getWidgetToken: protectedProcedure.query(async ({ ctx }) => {
    // Check if referral credentials are configured
    if (
      !env.REFERRAL_PROGRAM_CLIENT_SECRET ||
      !env.REFERRAL_PROGRAM_CLIENT_ID ||
      !env.NEXT_PUBLIC_REFREF_PRODUCT_ID
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Referral program credentials are not configured",
      });
    }

    const user = await db.query.user.findFirst({
      where: eq(userTable.id, ctx.userId),
    });

    const payload: JwtPayloadType = {
      sub: ctx.userId,
      email: user!.email,
      name: user!.name,
      productId: env.NEXT_PUBLIC_REFREF_PRODUCT_ID,
    };

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(env.REFERRAL_PROGRAM_CLIENT_SECRET));

    return {
      token,
      clientId: env.REFERRAL_PROGRAM_CLIENT_ID,
      userId: ctx.userId,
    };
  }),
});
