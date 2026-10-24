import type { DBType } from "@refref/coredb";
import { insertScopedEvent, type EventInput } from "@refref/coredb/security";
import { processEventForRewards } from "@refref/coredb";

/**
 * Create a new event and trigger reward processing
 */
export async function createEvent(db: DBType, input: EventInput) {
  const newEvent = await insertScopedEvent(db, input);
  await processEventForRewards(db, newEvent.id, 0);
  return newEvent;
}
