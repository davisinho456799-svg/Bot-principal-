import { Router, type IRouter } from "express";
import { eq, asc, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  assinaturasTable,
  malSnapshotsTable,
  notificacaoCanaisTable,
} from "@workspace/db";
import {
  ListSubscriptionsQueryParams,
  CreateSubscriptionBody,
  DeleteSubscriptionParams,
  CheckSubscriptionParams,
} from "@workspace/api-zod";
import { fetchMalItem } from "../lib/mal";
import { recordError } from "../lib/error-logging";

const router: IRouter = Router();

function toSubscriptionResponse(
  row: typeof assinaturasTable.$inferSelect,
  channelId: string | null,
) {
  return {
    id: row.id,
    discord_user_id: row.discordUserId,
    discord_channel_id: channelId ?? "",
    discord_guild_id: row.guildId,
    // A rota legada aceita apenas IDs numéricos do MAL. Assinaturas criadas
    // pelo bot podem usar slugs; nesse caso o valor não é representável neste
    // contrato antigo e será serializado como null pelo JSON.
    mal_item_id: Number(row.manhwaId),
    mal_item_type: row.tipo === "anime" ? "anime" : "manga",
    item_name: row.title,
    created_at: row.addedAt,
  };
}

// GET /subscriptions
router.get("/subscriptions", async (req, res): Promise<void> => {
  const query = ListSubscriptionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const conditions = query.data.guild_id
    ? [eq(assinaturasTable.guildId, query.data.guild_id)]
    : [];

  const rows = await db
    .select({
      subscription: assinaturasTable,
      channelId: notificacaoCanaisTable.channelId,
    })
    .from(assinaturasTable)
    .leftJoin(
      notificacaoCanaisTable,
      eq(assinaturasTable.guildId, notificacaoCanaisTable.guildId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(assinaturasTable.addedAt));

  res.json(rows.map((r) => toSubscriptionResponse(r.subscription, r.channelId)));
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
    .from(assinaturasTable)
    .where(
      and(
        eq(assinaturasTable.discordUserId, body.discord_user_id),
        eq(assinaturasTable.manhwaId, String(body.mal_item_id)),
        eq(assinaturasTable.guildId, body.discord_guild_id),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "Você já está inscrito neste item." });
    return;
  }

  const [row] = await db
    .insert(assinaturasTable)
    .values({
      discordUserId: body.discord_user_id,
      guildId: body.discord_guild_id,
      manhwaId: String(body.mal_item_id),
      source: "jikan",
      title: body.item_name,
      coverUrl: null,
      siteUrl: `https://myanimelist.net/${body.mal_item_type}/${body.mal_item_id}`,
      tipo: body.mal_item_type,
      adult: false,
    })
    .returning();

  res.status(201).json(toSubscriptionResponse(row, body.discord_channel_id));
});

// DELETE /subscriptions/:id
router.delete("/subscriptions/:id", async (req, res): Promise<void> => {
  const params = DeleteSubscriptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(assinaturasTable)
    .where(eq(assinaturasTable.id, params.data.id))
    .returning();

  if (!deleted) {
    const errorLog = await recordError({
      errorCode: "SUBSCRIPTION_NOT_FOUND",
      message: "Inscrição não encontrada.",
      httpStatus: 404,
      route: req.path,
      context: { subscriptionId: params.data.id },
    });
    res.locals.errorLogged = true;
    res.status(404).json({
      error: "Inscrição não encontrada.",
      error_id: errorLog.id,
    });
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
    .from(assinaturasTable)
    .where(eq(assinaturasTable.id, params.data.id))
    .limit(1);

  if (!sub) {
    const errorLog = await recordError({
      errorCode: "SUBSCRIPTION_NOT_FOUND",
      message: "Inscrição não encontrada.",
      httpStatus: 404,
      route: req.path,
      context: { subscriptionId: params.data.id },
    });
    res.locals.errorLogged = true;
    res.status(404).json({
      error: "Inscrição não encontrada.",
      error_id: errorLog.id,
    });
    return;
  }

  // Fetch latest data from MAL
  let malData;
  try {
    malData = await fetchMalItem(sub.malItemId, sub.malItemType as "manga" | "anime");
  } catch (err) {
    req.log.error({ err, subscriptionId: sub.id }, "MAL API fetch failed");
    const message =
      err instanceof Error
        ? err.message
        : "Erro ao buscar dados no MyAnimeList.";
    const errorLog = await recordError({
      discordGuildId: sub.discordGuildId,
      route: req.path,
      errorCode: "MAL_API_ERROR",
      message,
      httpStatus: 502,
      context: {
        subscriptionId: sub.id,
        malItemId: sub.malItemId,
        malItemType: sub.malItemType,
      },
    });
    res.locals.errorLogged = true;
    res.status(502).json({
      error: message,
      error_id: errorLog.id,
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
