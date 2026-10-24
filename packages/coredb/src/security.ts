import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { DBType } from "./index.js";
import {
  event,
  eventDefinition,
  participant,
  product,
  program,
  referral,
} from "./schema.js";
import type { EventMetadataV1Type } from "@refref/types";
import { assertLegacyTrackingAllowed } from "./referrals.js";

type ReadDb = Pick<DBType, "select">;
export class SecurityError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 403 | 409 = 403,
  ) {
    super(message);
  }
}

export async function validateProductScope(
  db: ReadDb,
  organizationId: string | undefined,
  productId: string,
  programId?: string,
) {
  if (!organizationId) throw new SecurityError("Organization context required");
  const [owned] = await db
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.orgId, organizationId)))
    .limit(1);
  if (!owned)
    throw new SecurityError("Product does not belong to your organization");
  if (programId) {
    const [ownedProgram] = await db
      .select({ id: program.id })
      .from(program)
      .where(and(eq(program.id, programId), eq(program.productId, productId)))
      .limit(1);
    if (!ownedProgram)
      throw new SecurityError("Program does not belong to your product");
  }
}

export interface EventInput {
  productId: string;
  programId?: string | null;
  participantId?: string | null;
  referralId?: string | null;
  eventType: string;
  metadata?: EventMetadataV1Type | null;
  attributionFromExternalId?: boolean;
}

export async function validateEventScope(
  db: ReadDb,
  input: Omit<EventInput, "eventType" | "metadata">,
) {
  if (input.programId) {
    const [ownedProgram] = await db
      .select({ id: program.id })
      .from(program)
      .where(
        and(
          eq(program.id, input.programId),
          eq(program.productId, input.productId),
        ),
      )
      .limit(1);
    if (!ownedProgram)
      throw new SecurityError("Program does not belong to your product");
  }
  let attendee: typeof participant.$inferSelect | undefined;
  if (input.participantId) {
    [attendee] = await db
      .select()
      .from(participant)
      .where(
        and(
          eq(participant.id, input.participantId),
          eq(participant.productId, input.productId),
        ),
      )
      .limit(1);
    if (!attendee)
      throw new SecurityError("Participant does not belong to your product");
  }
  if (input.referralId) {
    const [attribution] = await db
      .select({ referral })
      .from(referral)
      .innerJoin(participant, eq(participant.id, referral.referrerId))
      .where(
        and(
          eq(referral.id, input.referralId),
          eq(participant.productId, input.productId),
        ),
      )
      .limit(1);
    if (
      !attribution ||
      (input.programId && attribution.referral.programId !== input.programId) ||
      (attendee && attendee.externalId !== attribution.referral.externalId)
    ) {
      throw new SecurityError("Referral does not match the event scope");
    }
  }
}

// Business order IDs are unique within a product, not within a caller or process.
export async function insertScopedEvent(
  db: Pick<DBType, "select" | "insert">,
  input: EventInput,
) {
  await validateEventScope(db, input);
  await assertLegacyTrackingAllowed(db, input.programId);
  const [definition] = await db
    .select()
    .from(eventDefinition)
    .where(eq(eventDefinition.type, input.eventType))
    .limit(1);
  if (!definition) throw new SecurityError("Event definition not found", 400);
  const businessKey =
    input.eventType === "purchase" ? input.metadata?.orderId : null;
  if (
    input.eventType === "purchase" &&
    (!businessKey || businessKey.length > 200)
  ) {
    throw new SecurityError(
      "Purchase orderId must contain 1 to 200 characters",
      400,
    );
  }
  const metadata = JSON.parse(
    JSON.stringify(input.metadata ?? { schemaVersion: 1, source: "api" }),
  ) as EventMetadataV1Type;
  const values = {
    productId: input.productId,
    programId: input.programId || null,
    participantId: input.participantId || null,
    referralId: input.referralId || null,
    eventDefinitionId: definition.id,
    businessKey,
    status: "pending",
    metadata,
  };
  const [created] = await db
    .insert(event)
    .values(values)
    .onConflictDoNothing({
      target: [event.productId, event.eventDefinitionId, event.businessKey],
    })
    .returning();
  if (created) return created;
  if (!businessKey) throw new Error("Failed to create event");
  const [existing] = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.productId, input.productId),
        eq(event.eventDefinitionId, definition.id),
        eq(event.businessKey, businessKey),
      ),
    )
    .limit(1);
  if (
    !existing ||
    existing.programId !== values.programId ||
    (!input.attributionFromExternalId &&
      (existing.participantId !== values.participantId ||
        existing.referralId !== values.referralId)) ||
    !isDeepStrictEqual(existing.metadata, metadata)
  ) {
    throw new SecurityError(
      "Order retry conflicts with the original purchase",
      409,
    );
  }
  return existing;
}
