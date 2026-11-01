import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { referralIdSchema } from "@refref/types";
import { db, schema } from "@/server/db";
import { auth } from "@/lib/auth";
import { PartnerProgramTerms } from "@/components/partner-program-terms";

export const dynamic = "force-dynamic";

export default async function PartnerRulesPage({
  params,
}: {
  params: Promise<{ termsId: string }>;
}) {
  const { termsId } = await params;
  if (!referralIdSchema.safeParse(termsId).success) notFound();
  const [record] = await db
    .select({ rules: schema.programTerms, program: schema.program })
    .from(schema.programTerms)
    .innerJoin(
      schema.program,
      and(
        eq(schema.program.id, schema.programTerms.programId),
        eq(schema.program.productId, schema.programTerms.productId),
      ),
    )
    .where(eq(schema.programTerms.id, termsId));
  if (!record) notFound();
  const { rules, program } = record;
  const publicDocument =
    program.config?.selfService?.enabled &&
    program.config.selfService.termsId === rules.id;
  if (!publicDocument) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user.emailVerified) notFound();
    const [accepted] = await db
      .select({ id: schema.programAcceptance.id })
      .from(schema.programAcceptance)
      .where(
        and(
          eq(schema.programAcceptance.userId, session.user.id),
          eq(schema.programAcceptance.termsId, rules.id),
          eq(schema.programAcceptance.programId, program.id),
          eq(schema.programAcceptance.productId, program.productId),
        ),
      );
    const [existingMember] =
      rules.id === program.config?.selfService?.termsId
        ? await db
            .select({ id: schema.refcode.id })
            .from(schema.refcode)
            .innerJoin(
              schema.participant,
              eq(schema.participant.id, schema.refcode.participantId),
            )
            .where(
              and(
                eq(schema.refcode.productId, program.productId),
                eq(schema.refcode.programId, program.id),
                eq(schema.participant.ownerUserId, session.user.id),
                eq(schema.participant.productId, program.productId),
              ),
            )
            .limit(1)
        : [];
    const [staff] = await db
      .select({ id: schema.orgUser.id })
      .from(schema.orgUser)
      .innerJoin(schema.product, eq(schema.product.orgId, schema.orgUser.orgId))
      .where(
        and(
          eq(schema.orgUser.userId, session.user.id),
          eq(schema.product.id, program.productId),
        ),
      );
    if (!accepted && !staff && !existingMember) notFound();
  }
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Правила партнёрской программы</h1>
      <p>
        {program.name}. Редакция от{" "}
        {rules.createdAt.toLocaleString("ru-RU", { timeZone: "UTC" })} (UTC).
      </p>
      <PartnerProgramTerms
        terms={rules.rewardConfig}
        commission={rules.commission}
        startDate={rules.startDate}
        endDate={rules.endDate}
      />
      <article className="whitespace-pre-wrap break-words leading-relaxed">
        {rules.body}
      </article>
      <p className="text-sm text-muted-foreground">
        Это сохранённая редакция. Открытие документа не создаёт участие и не
        означает принятие правил. Новая редакция не переписывает эту запись.
      </p>
      <Link
        className="underline"
        href={`/participant-portal/join/${program.id}`}
        prefetch={false}
      >
        Войти в RefRef и открыть программу
      </Link>
    </main>
  );
}
