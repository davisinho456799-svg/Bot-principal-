import { Router, type IRouter } from "express";
import { eq, asc, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { subscriptionsTable, malSnapshotsTable } from "@workspace/db";
import {
  ListSubscriptionsQueryParams,
  CreateSubscriptionBody,
  DeleteSubscriptionParams,
  CheckSubscriptionParams,
} from "@workspace/api-zod";
import { fetchMalItem } from "../lib/mal";

const router: IRouter = Router();

// GET /subscriptions
router.get("/subscriptions", async (req, res): Promise<void> => {
  const query = ListSubscriptionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = query.data.guild_id
    ? [eq(subscriptionsTable.discordGuildId, query.data.guild_id)]
    : [];

  const rows = await db
    .select()
    .from(subscriptionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(subscriptionsTable.createdAt));

  res.json(
    rows.map((r) => ({
      id: r.id,
      discord_user_id: r.discordUserId,
      discord_channel_id: r.discordChannelId,
      discord_guild_id: r.discordGuildId,
      mal_item_id: r.malItemId,
      mal_item_type: r.malItemType,
      item_name: r.itemName,
      created_at: r.createdAt,
    })),
  );
});

// POST /subscriptions
router.post("/subscriptions", async (req, res): Promise<void> => {
  const parsed = CreateSubscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const body = parsed.data;

  // Check duplicate
  const existing = await db
    .select()
    .from(subscriptionsTable)
    .where(
      and(
        eq(subscriptionsTable.discordUserId, body.discord_user_id),
        eq(subscriptionsTable.malItemId, body.mal_item_id),
        eq(subscriptionsTable.discordGuildId, body.discord_guild_id),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "Você já está inscrito neste item." });
    return;
  }

  const [row] = await db
    .insert(subscriptionsTable)
    .values({
      discordUserId: body.discord_user_id,
      discordChannelId: body.discord_channel_id,
      discordGuildId: body.discord_guild_id,
      malItemId: body.mal_item_id,
      malItemType: body.mal_item_type,
      itemName: body.item_name,
    })
    .returning();

  res.status(201).json({
    id: row.id,
    discord_user_id: row.discordUserId,
    discord_channel_id: row.discordChannelId,
    discord_guild_id: row.discordGuildId,
    mal_item_id: row.malItemId,
    mal_item_type: row.malItemType,
    item_name: row.itemName,
    created_at: row.createdAt,
  });
});

// DELETE /subscriptions/:id
router.delete("/subscriptions/:id", async (req, res): Promise<void> => {
  const params = DeleteSubscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(subscriptionsTable)
    .where(eq(subscriptionsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Inscrição não encontrada." });
    return;
  }

  res.sendStatus(204);
});

// POST /subscriptions/:id/check
router.post("/subscriptions/:id/check", async (req, res): Promise<void> => {
  const params = CheckSubscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.id, params.data.id))
    .limit(1);

  if (!sub) {
    res.status(404).json({ error: "Inscrição não encontrada." });
    return;
  }

  // Fetch latest data from MAL
  let malData;
  try {
    malData = await fetchMalItem(sub.malItemId, sub.malItemType as "manga" | "anime");
  } catch (err) {
    req.log.error({ err, subscriptionId: sub.id }, "MAL API fetch failed");
    res.status(502).json({
      error:
        err instanceof Error
          ? err.message
          : "Erro ao buscar dados no MyAnimeList.",
    });
    return;
  }

  // Get existing snapshots ordered oldest first
  const snapshots = await db
    .select()
    .from(malSnapshotsTable)
    .where(eq(malSnapshotsTable.subscriptionId, sub.id))
    .orderBy(asc(malSnapshotsTable.checkedAt));

  const previous = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  // Insert new snapshot
  const [newSnapshot] = await db
    .insert(malSnapshotsTable)
    .values({
      subscriptionId: sub.id,
      synopsis: malData.synopsis,
      score: malData.score != null ? String(malData.score) : null,
      status: malData.status,
      chapters: malData.chapters,
    })
    .returning();

  // Keep only 2 snapshots — delete oldest if now > 2
  if (snapshots.length >= 2) {
    const toDelete = snapshots.slice(0, snapshots.length - 1);
    for (const old of toDelete) {
      await db
        .delete(malSnapshotsTable)
        .where(eq(malSnapshotsTable.id, old.id));
    }
  }

  // Detect chapter increase
  const previousChapters = previous?.chapters ?? null;
  const currentChapters = malData.chapters;
  const changed =
    currentChapters != null &&
    previousChapters != null &&
    currentChapters > previousChapters;

  res.json({
    changed,
    subscription_id: sub.id,
    item_name: sub.itemName,
    mal_item_id: sub.malItemId,
    mal_item_type: sub.malItemType,
    current: {
      synopsis: malData.synopsis,
      score: malData.score,
      status: malData.status,
      chapters: currentChapters,
      checked_at: newSnapshot.checkedAt,
    },
    previous: previous
      ? {
          synopsis: previous.synopsis,
          score: previous.score != null ? parseFloat(previous.score) : null,
          status: previous.status,
          chapters: previous.chapters,
          checked_at: previous.checkedAt,
        }
      : null,
  });
});

export default router;
