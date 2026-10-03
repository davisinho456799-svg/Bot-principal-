import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { monitoredWorksTable } from "@workspace/db/schema";
import { numberActiveMonitorWorks } from "./monitor-work-numbering.js";

export async function getActiveNumberedMonitorWorks() {
  const works = await db
    .select()
    .from(monitoredWorksTable)
    .where(eq(monitoredWorksTable.active, true));
  return numberActiveMonitorWorks(works);
}