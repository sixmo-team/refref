import { and, asc, eq, sql } from "drizzle-orm";
import {
  type RewardConfigType,
  type FrozenCommission,
  inputRefcodeSchema,
  partnerRulesBodySchema,
} from "@refref/types";
import type { DBType } from "./index.js";
import type { CoreTransaction } from "./reward-engine.js";
import * as s from "./schema.js";
import {
  ReferralError,
  partnerTermsFingerprint,
  approvedReferralEconomics,
  verifiedPersonAccount,
} from "./referrals.js";
import { ownParticipant } from "./payouts.js";

export type PartnerCode = {
  productId: string;
  programId: string;
  participantId: string;
  codeId: string;
  code: string;
  isActive: boolean;
};
export type PartnerParticipation =
  | {
      state: "joined";
      productId: string;
      programId: string;
      codes: PartnerCode[];
    }
  | {
      state: "join";
      productId: string;
      programId: string;
      programName: string;
      codes: PartnerCode[];
      rules: {
        id: string;
        body: string;
        rewardConfig: RewardConfigType;
        commission: FrozenCommission;
        publishedAt: Date;
        startDate: Date | null;
        endDate: Date | null;
      };
    };
const codeProjection = (code: typeof s.refcode.$inferSelect): PartnerCode => ({
  productId: code.productId,
  programId: code.programId,
  participantId: code.participantId,
  codeId: code.id,
  code: code.code,
  isActive: code.isActive,
});

// Both administrator-assisted and session-derived enrollment serialize on the same owner.
export async function ensureReferrerParticipant(
  tx: CoreTransaction,
  input: {
    productId: string;
    ownerUserId: string;
    actorId: string;
    participantId?: string;
    evidence?: string;
  },
) {
  await verifiedPersonAccount(tx, input.ownerUserId);
  if (input.actorId !== input.ownerUserId && !input.evidence?.trim())
    throw new ReferralError(
      "FORBIDDEN",
      403,
      "Administrative ownership evidence required",
    );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`participant-owner:${input.productId}:${input.ownerUserId}`},0))`,
  );
  const [owned] = await tx
    .select()
    .from(s.participant)
    .where(
      and(
        eq(s.participant.productId, input.productId),
        eq(s.participant.ownerUserId, input.ownerUserId),
      ),
    )
    .for("update");
  if (owned) {
    if (input.participantId && owned.id !== input.participantId)
      throw new ReferralError(
        "OWNERSHIP_CONFLICT",
        409,
        "Account already owns another participant in this product",
      );
    if (input.evidence && owned.ownershipEvidence !== input.evidence)
      throw new ReferralError(
        "OWNERSHIP_CONFLICT",
        409,
        "Verified ownership evidence is immutable",
      );
    return owned;
  }
  if (input.participantId) {
    const [existing] = await tx
      .select()
      .from(s.participant)
      .where(
        and(
          eq(s.participant.id, input.participantId),
          eq(s.participant.productId, input.productId),
        ),
      )
      .for("update");
    if (!existing?.externalId || existing.ownerUserId || !input.evidence)
      throw new ReferralError(
        "OWNERSHIP_CONFLICT",
        409,
        "Explicit verified unowned participant required",
      );
    const [linked] = await tx
      .update(s.participant)
      .set({
        ownerUserId: input.ownerUserId,
        ownershipVerifiedBy: input.actorId,
        ownershipVerifiedAt: new Date(),
        ownershipEvidence: input.evidence.trim(),
        updatedAt: new Date(),
      })
      .where(eq(s.participant.id, existing.id))
      .returning();
    if (!linked) throw new Error("Participant ownership update missing");
    return linked;
  }
  const [created] = await tx
    .insert(s.participant)
    .values({
      productId: input.productId,
      externalId: input.ownerUserId,
      ownerUserId: input.ownerUserId,
      ownershipVerifiedBy: input.actorId,
      ownershipVerifiedAt: new Date(),
      ownershipEvidence: input.evidence?.trim() ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!created)
    throw new ReferralError(
      "OWNERSHIP_CONFLICT",
      409,
      "Existing external participant requires explicit ownership verification",
    );
  return created;
}

export async function createParticipantCode(
  tx: CoreTransaction,
  input: {
    productId: string;
    programId: string;
    participantId: string;
    code: string;
  },
) {
  const code = inputRefcodeSchema.parse(input.code);
  const [created] = await tx
    .insert(s.refcode)
    .values({ ...input, code })
    .onConflictDoNothing()
    .returning();
  if (created) return codeProjection(created);
  const [prior] = await tx
    .select()
    .from(s.refcode)
    .where(eq(s.refcode.code, code));
  if (
    prior?.productId === input.productId &&
    prior.programId === input.programId &&
    prior.participantId === input.participantId
  )
    return codeProjection(prior);
  throw new ReferralError(
    "REFERRAL_CODE_TAKEN",
    409,
    "Этот промокод уже занят. Выберите другой.",
  );
}

export async function firstParticipantCode(
  tx: CoreTransaction,
  input: {
    productId: string;
    programId: string;
    participantId: string;
    code: string;
  },
) {
  const [existing] = await tx
    .select()
    .from(s.refcode)
    .where(
      and(
        eq(s.refcode.productId, input.productId),
        eq(s.refcode.programId, input.programId),
        eq(s.refcode.participantId, input.participantId),
      ),
    )
    .orderBy(asc(s.refcode.createdAt), s.refcode.id)
    .limit(1);
  return existing ? codeProjection(existing) : createParticipantCode(tx, input);
}

function requireActive(program: typeof s.program.$inferSelect) {
  const now = Date.now();
  if (
    program.status !== "active" ||
    (program.startDate && program.startDate.getTime() > now) ||
    (program.endDate && program.endDate.getTime() < now)
  )
    throw new ReferralError(
      "FORBIDDEN",
      403,
      "Самостоятельное подключение к программе недоступно.",
    );
}
async function currentRules(
  db: Pick<DBType, "select">,
  program: typeof s.program.$inferSelect,
) {
  const economics = await approvedReferralEconomics(db, program);
  const [rules] = await db
    .select()
    .from(s.programTerms)
    .where(
      and(
        eq(s.programTerms.id, program.config?.selfService?.termsId ?? ""),
        eq(s.programTerms.programId, program.id),
        eq(s.programTerms.productId, program.productId),
      ),
    );
  if (
    !rules ||
    rules.termsFingerprint !==
      partnerTermsFingerprint(program, economics.commission)
  )
    throw new ReferralError(
      "PROGRAM_RULES_CHANGED",
      409,
      "Для действующих условий ещё не опубликованы правила программы.",
    );
  return rules;
}
async function selfServiceProgram(
  tx: CoreTransaction,
  programId: string,
  userId: string,
) {
  const [program] = await tx
    .select()
    .from(s.program)
    .where(eq(s.program.id, programId))
    .for("share");
  if (!program)
    throw new ReferralError("FORBIDDEN", 403, "Программа недоступна.");
  if (!program.config?.selfService?.enabled) {
    const [existingMember] = await tx
      .select({ id: s.refcode.id })
      .from(s.refcode)
      .innerJoin(s.participant, eq(s.participant.id, s.refcode.participantId))
      .where(
        and(
          eq(s.refcode.programId, programId),
          eq(s.refcode.productId, program.productId),
          eq(s.participant.ownerUserId, userId),
          eq(s.participant.productId, program.productId),
        ),
      )
      .limit(1);
    if (!existingMember)
      throw new ReferralError(
        "FORBIDDEN",
        403,
        "Самостоятельное подключение к программе недоступно.",
      );
  }
  requireActive(program);
  return { program, rules: await currentRules(tx, program) };
}
async function requireAcceptance(
  tx: CoreTransaction,
  userId: string,
  programId: string,
  termsId: string,
) {
  const [acceptance] = await tx
    .select({ id: s.programAcceptance.id })
    .from(s.programAcceptance)
    .where(
      and(
        eq(s.programAcceptance.userId, userId),
        eq(s.programAcceptance.programId, programId),
        eq(s.programAcceptance.termsId, termsId),
      ),
    );
  if (!acceptance)
    throw new ReferralError(
      "PROGRAM_RULES_CHANGED",
      409,
      "Откройте программу и примите действующую редакцию правил.",
    );
}

export async function publishPartnerTerms(
  db: DBType,
  actorId: string,
  input: {
    productId: string;
    programId: string;
    body: string;
    termsFingerprint: string;
    confirmReviewedRules: boolean;
  },
) {
  const body = partnerRulesBodySchema.parse(input.body);
  if (!input.confirmReviewedRules)
    throw new ReferralError(
      "INVALID_REQUEST",
      400,
      "Explicit review of programme rules required",
    );
  return db.transaction(async (tx) => {
    const [program] = await tx
      .select()
      .from(s.program)
      .where(
        and(
          eq(s.program.id, input.programId),
          eq(s.program.productId, input.productId),
        ),
      )
      .for("update");
    if (!program?.config?.rewardConfig)
      throw new ReferralError(
        "FORBIDDEN",
        403,
        "Configure the programme's economic terms first",
      );
    const economics = await approvedReferralEconomics(tx, program);
    const fingerprint = partnerTermsFingerprint(program, economics.commission);
    if (input.termsFingerprint !== fingerprint)
      throw new ReferralError(
        "PROGRAM_RULES_CHANGED",
        409,
        "Условия изменились. Проверьте их перед публикацией правил.",
      );
    const [prior] = await tx
      .select()
      .from(s.programTerms)
      .where(
        and(
          eq(s.programTerms.id, program.config.selfService?.termsId ?? ""),
          eq(s.programTerms.productId, input.productId),
          eq(s.programTerms.programId, input.programId),
        ),
      );
    if (prior?.body === body && prior.termsFingerprint === fingerprint)
      return prior;
    const [rules] = await tx
      .insert(s.programTerms)
      .values({
        productId: input.productId,
        programId: input.programId,
        body,
        rewardConfig: program.config.rewardConfig,
        termsFingerprint: fingerprint,
        publishedBy: actorId,
        commission: economics.commission,
        startDate: program.startDate,
        endDate: program.endDate,
      })
      .returning();
    if (!rules) throw new Error("Published programme rules missing");
    await tx
      .update(s.program)
      .set({
        config: {
          ...program.config,
          selfService: {
            enabled: program.config.selfService?.enabled ?? false,
            termsId: rules.id,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(s.program.id, program.id));
    return rules;
  });
}

export async function setPartnerSelfService(
  db: DBType,
  input: { productId: string; programId: string; enabled: boolean },
) {
  return db.transaction(async (tx) => {
    const [program] = await tx
      .select()
      .from(s.program)
      .where(
        and(
          eq(s.program.id, input.programId),
          eq(s.program.productId, input.productId),
        ),
      )
      .for("update");
    if (!program?.config)
      throw new ReferralError("FORBIDDEN", 403, "Programme unavailable");
    if (input.enabled) {
      requireActive(program);
      await currentRules(tx, program);
    }
    const selfService = {
      ...program.config.selfService,
      enabled: input.enabled,
    };
    await tx
      .update(s.program)
      .set({
        config: { ...program.config, selfService },
        updatedAt: new Date(),
      })
      .where(eq(s.program.id, program.id));
    return selfService;
  });
}

export async function partnerParticipation(
  db: DBType,
  userId: string,
  programId: string,
): Promise<PartnerParticipation> {
  await verifiedPersonAccount(db, userId);
  return db.transaction(async (tx) => {
    const [program] = await tx
      .select()
      .from(s.program)
      .where(eq(s.program.id, programId))
      .for("share");
    if (!program)
      throw new ReferralError("FORBIDDEN", 403, "Программа недоступна.");
    const codes = await tx
      .select({ code: s.refcode })
      .from(s.refcode)
      .innerJoin(s.participant, eq(s.participant.id, s.refcode.participantId))
      .where(
        and(
          eq(s.refcode.productId, program.productId),
          eq(s.refcode.programId, program.id),
          eq(s.participant.ownerUserId, userId),
          eq(s.participant.productId, program.productId),
        ),
      )
      .orderBy(asc(s.refcode.createdAt), s.refcode.id);
    const ownCodes = codes.map(({ code }) => codeProjection(code));
    const now = Date.now();
    if (
      ownCodes.length &&
      (!program.config?.selfService?.termsId ||
        program.status !== "active" ||
        (program.startDate && program.startDate.getTime() > now) ||
        (program.endDate && program.endDate.getTime() < now))
    )
      return {
        state: "joined" as const,
        productId: program.productId,
        programId,
        codes: ownCodes,
      };
    const active = await selfServiceProgram(tx, programId, userId);
    const [accepted] = await tx
      .select({ id: s.programAcceptance.id })
      .from(s.programAcceptance)
      .where(
        and(
          eq(s.programAcceptance.userId, userId),
          eq(s.programAcceptance.programId, programId),
          eq(s.programAcceptance.termsId, active.rules.id),
        ),
      );
    if (accepted && ownCodes.length)
      return {
        state: "joined",
        productId: program.productId,
        programId,
        codes: ownCodes,
      };
    return {
      state: "join",
      productId: program.productId,
      programId,
      programName: program.name,
      codes: ownCodes,
      rules: {
        id: active.rules.id,
        body: active.rules.body,
        rewardConfig: active.rules.rewardConfig,
        commission: active.rules.commission,
        publishedAt: active.rules.createdAt,
        startDate: active.rules.startDate,
        endDate: active.rules.endDate,
      },
    };
  });
}

export async function joinPartnerProgram(
  db: DBType,
  userId: string,
  input: {
    programId: string;
    termsId: string;
    acceptRules: boolean;
    code: string;
  },
) {
  if (!input.acceptRules)
    throw new ReferralError(
      "INVALID_REQUEST",
      400,
      "Необходимо принять правила программы.",
    );
  const code = inputRefcodeSchema.parse(input.code);
  await verifiedPersonAccount(db, userId);
  return db.transaction(async (tx) => {
    const { program, rules } = await selfServiceProgram(
      tx,
      input.programId,
      userId,
    );
    if (rules.id !== input.termsId)
      throw new ReferralError(
        "PROGRAM_RULES_CHANGED",
        409,
        "Правила изменились. Прочитайте новую редакцию и подтвердите согласие.",
      );
    const owner = await ensureReferrerParticipant(tx, {
      productId: program.productId,
      ownerUserId: userId,
      actorId: userId,
    });
    const result = await firstParticipantCode(tx, {
      productId: program.productId,
      programId: program.id,
      participantId: owner.id,
      code,
    });
    await tx
      .insert(s.programAcceptance)
      .values({
        productId: program.productId,
        programId: program.id,
        participantId: owner.id,
        userId,
        termsId: rules.id,
      })
      .onConflictDoNothing();
    return result;
  });
}

export async function partnerCodeAvailability(
  db: DBType,
  userId: string,
  input: { programId: string; code: string },
) {
  const code = inputRefcodeSchema.parse(input.code);
  await verifiedPersonAccount(db, userId);
  return db.transaction(async (tx) => {
    await selfServiceProgram(tx, input.programId, userId);
    const [existing] = await tx
      .select({ id: s.refcode.id })
      .from(s.refcode)
      .where(eq(s.refcode.code, code))
      .limit(1);
    return { code, available: !existing };
  });
}

export async function createPartnerCode(
  db: DBType,
  userId: string,
  input: { programId: string; code: string },
) {
  return db.transaction(async (tx) => {
    const { program, rules } = await selfServiceProgram(
      tx,
      input.programId,
      userId,
    );
    const owner = await ownParticipant(tx, userId, program.productId);
    await requireAcceptance(tx, userId, program.id, rules.id);
    return createParticipantCode(tx, {
      productId: program.productId,
      programId: program.id,
      participantId: owner.id,
      code: input.code,
    });
  });
}

export async function setPartnerCodeActive(
  db: DBType,
  userId: string,
  input: { productId: string; codeId: string; isActive: boolean },
) {
  return db.transaction(async (tx) => {
    const owner = await ownParticipant(tx, userId, input.productId);
    const [code] = await tx
      .select()
      .from(s.refcode)
      .where(
        and(
          eq(s.refcode.id, input.codeId),
          eq(s.refcode.productId, input.productId),
          eq(s.refcode.participantId, owner.id),
        ),
      );
    if (!code)
      throw new ReferralError("FORBIDDEN", 403, "Этот код недоступен.");
    if (input.isActive) {
      const { program, rules } = await selfServiceProgram(
        tx,
        code.programId,
        userId,
      );
      await requireAcceptance(tx, userId, program.id, rules.id);
    }
    const [updated] = await tx
      .update(s.refcode)
      .set({ isActive: input.isActive, updatedAt: new Date() })
      .where(
        and(eq(s.refcode.id, code.id), eq(s.refcode.participantId, owner.id)),
      )
      .returning();
    if (!updated) throw new Error("Code activation update missing");
    return codeProjection(updated);
  });
}
