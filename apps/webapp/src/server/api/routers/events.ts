import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  adminProcedure,
} from "@/server/api/trpc";
import { db, schema } from "@/server/db";
const {
  event: eventTable,
  eventDefinition,
  participantProfileColumns,
  participant,
  program: programTable,
  referral: referralTable,
} = schema;
import { eq, and, desc, asc, sql, count, ilike } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { eventMetadataV1Schema } from "@refref/types";
import { processEventForRewards } from "@refref/coredb";
import {
  insertScopedEvent,
  SecurityError,
  validateProductScope,
} from "@refref/coredb/security";
import { safeError } from "@refref/utils";

// Input schema for creating events
const createEventSchema = z.object({
  productId: z.string(),
  programId: z.string().optional(),
  eventType: z.string(), // e.g., "signup", "purchase"
  participantId: z.string().optional(),
  referralId: z.string().optional(),
  metadata: eventMetadataV1Schema.optional(),
});

export const eventsRouter = createTRPCRouter({
  // Create a new event
  create: adminProcedure
    .input(createEventSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.productId !== ctx.activeProductId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Product does not match the active product",
        });
      }
      let newEvent;
      try {
        newEvent = await insertScopedEvent(ctx.db, input);
      } catch (error) {
        if (error instanceof SecurityError) {
          throw new TRPCError({
            code:
              error.statusCode === 409
                ? "CONFLICT"
                : error.statusCode === 400
                  ? "BAD_REQUEST"
                  : "FORBIDDEN",
            message: error.message,
          });
        }
        throw error;
      }
      await processEventForRewards(ctx.db, newEvent.id);

      return newEvent;
    }),

  // Get events for a program
  getByProgram: protectedProcedure
    .input(
      z.object({
        programId: z.string(),
        page: z.number().min(1).default(1),
        pageSize: z.number().min(1).max(100).default(20),
        status: z.enum(["pending", "processed", "failed"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { programId, page, pageSize, status } = input;

      // Verify program belongs to active product
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(
          and(
            eq(programTable.id, programId),
            eq(programTable.productId, ctx.activeProductId),
          ),
        )
        .limit(1);

      if (!program) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Program not found or does not belong to your product",
        });
      }

      // Build where clause
      const whereConditions = [eq(eventTable.programId, programId)];
      if (status) {
        whereConditions.push(eq(eventTable.status, status));
      }

      // Get total count
      const [countResult] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(eventTable)
        .where(and(...whereConditions));

      const total = countResult?.count ?? 0;

      // Get paginated events with related data
      const events = await ctx.db
        .select({
          event: eventTable,
          eventDefinition: eventDefinition,
          participant: participantProfileColumns,
          referral: referralTable,
        })
        .from(eventTable)
        .leftJoin(
          eventDefinition,
          eq(eventTable.eventDefinitionId, eventDefinition.id),
        )
        .leftJoin(participant, eq(eventTable.participantId, participant.id))
        .leftJoin(referralTable, eq(eventTable.referralId, referralTable.id))
        .where(and(...whereConditions))
        .orderBy(desc(eventTable.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        data: events.map((row) => ({
          ...row.event,
          eventDefinition: row.eventDefinition,
          participant: row.participant,
          referral: row.referral,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }),

  // Get a single event by ID
  getById: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input }) => {
      const [eventData] = await ctx.db
        .select({
          event: eventTable,
          eventDefinition: eventDefinition,
          participant: participantProfileColumns,
          referral: referralTable,
        })
        .from(eventTable)
        .leftJoin(
          eventDefinition,
          eq(eventTable.eventDefinitionId, eventDefinition.id),
        )
        .leftJoin(participant, eq(eventTable.participantId, participant.id))
        .leftJoin(referralTable, eq(eventTable.referralId, referralTable.id))
        .where(eq(eventTable.id, input))
        .limit(1);

      if (!eventData) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Event not found",
        });
      }

      // Verify event belongs to active product
      const productId = eventData.event.productId;
      if (productId !== ctx.activeProductId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Event does not belong to your product",
        });
      }

      return {
        ...eventData.event,
        eventDefinition: eventData.eventDefinition,
        participant: eventData.participant,
        referral: eventData.referral,
      };
    }),

  // Update event status (for admin/debugging purposes)
  updateStatus: adminProcedure
    .input(
      z.object({
        eventId: z.string(),
        status: z.enum(["pending", "processed", "failed"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Authorize the identified event's product in the current organization.
      const [existingEvent] = await ctx.db
        .select()
        .from(eventTable)
        .where(eq(eventTable.id, input.eventId))
        .limit(1);

      if (!existingEvent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Event not found",
        });
      }

      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        existingEvent.productId,
      );
      if (existingEvent.metadata?.schemaVersion === 2)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Accepted financial events cannot be manually rewritten",
        });

      const [updatedEvent] = await ctx.db
        .update(eventTable)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(eventTable.id, input.eventId))
        .returning();

      return updatedEvent;
    }),

  // Get all events across all programs for the active product
  getAll: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1),
        pageSize: z.number().int().min(1).max(100),
        scope: z
          .object({
            organizationId: z.string().min(1),
            productId: z.string().min(1),
            userId: z.string().min(1),
          })
          .strict(),
        filters: z
          .array(
            z.object({
              id: z.string(),
              value: z.union([z.string(), z.array(z.string())]),
              variant: z.string(),
              operator: z.string(),
            }),
          )
          .optional(),
        sort: z
          .object({
            field: z.enum(["eventType", "status", "createdAt"]),
            direction: z.enum(["asc", "desc"]),
          })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { page, pageSize, filters, sort } = input;
      if (
        input.scope.organizationId !== ctx.activeOrganizationId ||
        input.scope.userId !== ctx.userId
      )
        throw new TRPCError({ code: "FORBIDDEN" });
      await validateProductScope(
        ctx.db,
        ctx.activeOrganizationId,
        input.scope.productId,
      );

      // Build where clause for all filters
      const whereConditions = [];

      if (filters && filters.length > 0) {
        filters.forEach((filter) => {
          if (
            filter.id === "eventName" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(
              ilike(eventDefinition.name, `%${filter.value}%`),
            );
          }
          // Filter by eventType
          if (
            filter.id === "eventType" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(
              sql`${eventDefinition.type} ILIKE ${"%" + filter.value + "%"}`,
            );
          }
          // Filter by status
          if (
            filter.id === "status" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(eq(eventTable.status, filter.value));
          }
          // Filter by participantEmail
          if (
            filter.id === "participantEmail" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(
              sql`${participant.email} ILIKE ${"%" + filter.value + "%"}`,
            );
          }
          // Filter by programName
          if (
            filter.id === "programName" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(
              sql`${programTable.name} ILIKE ${"%" + filter.value + "%"}`,
            );
          }
          // Filter by referralId
          if (
            filter.id === "referralId" &&
            filter.variant === "text" &&
            typeof filter.value === "string"
          ) {
            whereConditions.push(eq(eventTable.referralId, filter.value));
          }
        });
      }

      // Use the same authorized product predicate for both count and rows.
      whereConditions.push(eq(eventTable.productId, input.scope.productId));

      const where =
        whereConditions.length > 0 ? and(...whereConditions) : undefined;

      // Map sort field to column
      const sortFieldMap = {
        eventType: eventDefinition.type,
        status: eventTable.status,
        createdAt: eventTable.createdAt,
      };

      const orderByColumn = sort
        ? sortFieldMap[sort.field]
        : eventTable.createdAt;
      const orderByDirection = sort?.direction ?? "desc";

      // Get total count
      const [totalResult] = await ctx.db
        .select({ count: count() })
        .from(eventTable)
        .leftJoin(
          eventDefinition,
          eq(eventTable.eventDefinitionId, eventDefinition.id),
        )
        .leftJoin(participant, eq(eventTable.participantId, participant.id))
        .leftJoin(programTable, eq(eventTable.programId, programTable.id))
        .where(where);

      const total = totalResult?.count ?? 0;

      // Get paginated data with related information
      const events = await ctx.db
        .select({
          event: eventTable,
          eventDefinition: eventDefinition,
          participant: participantProfileColumns,
          program: programTable,
          referral: referralTable,
        })
        .from(eventTable)
        .leftJoin(
          eventDefinition,
          eq(eventTable.eventDefinitionId, eventDefinition.id),
        )
        .leftJoin(participant, eq(eventTable.participantId, participant.id))
        .leftJoin(programTable, eq(eventTable.programId, programTable.id))
        .leftJoin(referralTable, eq(eventTable.referralId, referralTable.id))
        .where(where)
        .orderBy(
          orderByDirection === "desc"
            ? desc(orderByColumn)
            : asc(orderByColumn),
          asc(eventTable.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      // Format the response
      const data = events.map((row) => ({
        id: row.event.id,
        productId: row.event.productId,
        programId: row.event.programId,
        programName: row.program?.name,
        participantId: row.event.participantId,
        participantEmail: row.participant?.email,
        participantExternalId: row.participant?.externalId,
        participantName: row.participant?.name,
        referralId: row.event.referralId,
        eventType: row.eventDefinition?.type,
        eventName: row.eventDefinition?.name,
        status: row.event.status,
        metadata: row.event.metadata,
        //ipHash: row.event.ipHash,
        //visitorFingerprint: row.event.visitorFingerprint,
        //deduplicationKey: row.event.deduplicationKey,
        createdAt: row.event.createdAt,
        updatedAt: row.event.updatedAt,
      }));

      return { data, total };
    }),

  // Get event statistics for a program
  getStatsByProgram: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input: programId }) => {
      // Verify program belongs to active product
      const [program] = await ctx.db
        .select()
        .from(programTable)
        .where(
          and(
            eq(programTable.id, programId),
            eq(programTable.productId, ctx.activeProductId),
          ),
        )
        .limit(1);

      if (!program) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Program not found or does not belong to your product",
        });
      }

      // Get event counts by status
      const statusCounts = await ctx.db
        .select({
          status: eventTable.status,
          count: sql<number>`count(*)`,
        })
        .from(eventTable)
        .where(eq(eventTable.programId, programId))
        .groupBy(eventTable.status);

      // Get event counts by type
      const typeCounts = await ctx.db
        .select({
          type: eventDefinition.type,
          name: eventDefinition.name,
          count: sql<number>`count(*)`,
        })
        .from(eventTable)
        .innerJoin(
          eventDefinition,
          eq(eventTable.eventDefinitionId, eventDefinition.id),
        )
        .where(eq(eventTable.programId, programId))
        .groupBy(eventDefinition.type, eventDefinition.name);

      // Get recent events
      const recentEvents = await ctx.db
        .select({
          event: eventTable,
          eventDefinition: eventDefinition,
        })
        .from(eventTable)
        .leftJoin(
          eventDefinition,
          eq(eventTable.eventDefinitionId, eventDefinition.id),
        )
        .where(eq(eventTable.programId, programId))
        .orderBy(desc(eventTable.createdAt))
        .limit(10);

      return {
        statusCounts: statusCounts.reduce(
          (acc, curr) => {
            acc[curr.status] = curr.count;
            return acc;
          },
          {} as Record<string, number>,
        ),
        typeCounts: typeCounts.map((tc) => ({
          type: tc.type,
          name: tc.name,
          count: tc.count,
        })),
        recentEvents: recentEvents.map((re) => ({
          ...re.event,
          eventDefinition: re.eventDefinition,
        })),
        total: statusCounts.reduce((sum, curr) => sum + curr.count, 0),
      };
    }),
});
