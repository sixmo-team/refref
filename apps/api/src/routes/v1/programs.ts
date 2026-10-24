import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validateProductScope, SecurityError } from "@refref/coredb/security";

interface GetProgramParams {
  Params: {
    id: string;
  };
}

export default async function programsRoutes(fastify: FastifyInstance) {
  /**
   * GET /v1/programs/:id
   * Get program configuration by ID with API key authentication
   */
  fastify.get<GetProgramParams>(
    "/:id",
    {
      onRequest: [fastify.authenticateApiKey],
    },
    async (request, reply) => {
      try {
        const { id: programId } = request.params;

        // Fetch the program from database
        const programRecord = await request.db.query.program.findFirst({
          where: (program, { eq }) => eq(program.id, programId),
        });

        if (!programRecord) {
          return reply.code(404).send({
            error: "Not Found",
            message: "Program not found",
          });
        }
        await validateProductScope(
          request.db,
          request.organization?.id,
          programRecord.productId,
          programRecord.id,
        );

        // Return the program data
        return reply.send({
          success: true,
          data: programRecord,
        });
      } catch (error) {
        request.log.error({ error }, "Error fetching program");
        if (error instanceof SecurityError) {
          return reply.code(404).send({
            error: "Not Found",
            message: "Program not found",
          });
        }

        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Bad Request",
            message: "Invalid request parameters",
            details: error.issues,
          });
        }

        return reply.code(500).send({
          error: "Internal Server Error",
          message: "An unexpected error occurred",
        });
      }
    },
  );
}
