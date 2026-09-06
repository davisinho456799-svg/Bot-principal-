import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  CreateMonitoredWorkBody,
  CreateMonitoredWorkResponse,
  DeleteMonitoredWorkParams,
  GetMonitorConfigResponse,
  GetMonitorOverviewResponse,
  ListDiscordChannelsResponse,
  ListMonitoredWorksResponse,
  RunMonitorNowResponse,
  UpdateMonitoredWorkBody,
  UpdateMonitoredWorkParams,
  UpdateMonitoredWorkResponse,
  UpdateMonitorConfigBody,
  UpdateMonitorConfigResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  detectedChaptersTable,
  monitorActivityTable,
  monitorConfigTable,
  monitoredWorksTable,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { runMonitor } from "../services/monitor-service";

const router: IRouter = Router();

function serializeWork(work: typeof monitoredWorksTable.$inferSelect) {
  return {
    id: work.id,
    title: work.title,
    platform: work.platform,
    listingUrl: work.listingUrl,
    active: work.active,
    chaptersSeen: work.chaptersSeen,
    lastCheckedAt: work.lastCheckedAt?.toISOString() ?? null,
    lastPublishedAt: work.lastPublishedAt?.toISOString() ?? null,
    lastStatus: work.lastStatus,
  };
}

async function getConfig() {
  const [config] = await db.select().from(monitorConfigTable).limit(1);
  if (config) return config;
  const [created] = await db
    .insert(monitorConfigTable)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [existing] = await db.select().from(monitorConfigTable).limit(1);
  return existing ?? { id: 1, discordChannelId: null, discordChannelName: null, intervalMinutes: 30, updatedAt: new Date() };
}

router.get("/monitor/overview", async (_req, res, next) => {
  try {
    const [active] = await db
      .select({ value: sql<number>`count(*)` })
      .from(monitoredWorksTable)
      .where(eq(monitoredWorksTable.active, true));
    const [tracked] = await db
      .select({ value: sql<number>`coalesce(sum(${monitoredWorksTable.chaptersSeen}), 0)` })
      .from(monitoredWorksTable);
    const [sent] = await db
      .select({ value: sql<number>`count(*)` })
      .from(monitorActivityTable)
      .where(eq(monitorActivityTable.status, "Published"));
    const activities = await db
      .select({
        id: monitorActivityTable.id,
        workTitle: monitoredWorksTable.title,
        platform: monitoredWorksTable.platform,
        chapterCount: monitorActivityTable.chapterCount,
        status: monitorActivityTable.status,
        createdAt: monitorActivityTable.createdAt,
      })
      .from(monitorActivityTable)
      .innerJoin(monitoredWorksTable, eq(monitorActivityTable.workId, monitoredWorksTable.id))
      .orderBy(desc(monitorActivityTable.createdAt))
      .limit(8);
    const [lastRun] = await db
      .select({ value: sql<Date | null>`max(${monitoredWorksTable.lastCheckedAt})` })
      .from(monitoredWorksTable);
    const config = await getConfig();
    const lastRunAt = lastRun?.value?.toISOString() ?? null;
    const nextRunAt = lastRunAt
      ? new Date(new Date(lastRunAt).getTime() + config.intervalMinutes * 60_000).toISOString()
      : null;
    const response = {
      activeWorks: Number(active?.value ?? 0),
      chaptersTracked: Number(tracked?.value ?? 0),
      postsSent: Number(sent?.value ?? 0),
      lastRunAt,
      nextRunAt,
      recentActivity: activities.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
    };
    res.json(GetMonitorOverviewResponse.parse(response));
  } catch (error) {
    next(error);
  }
});

router.get("/monitor/works", async (_req, res, next) => {
  try {
    const works = await db.select().from(monitoredWorksTable).orderBy(desc(monitoredWorksTable.createdAt));
    res.json(ListMonitoredWorksResponse.parse(works.map(serializeWork)));
  } catch (error) {
    next(error);
  }
});

router.post("/monitor/works", async (req, res, next) => {
  try {
    const body = CreateMonitoredWorkBody.parse(req.body);
    const [work] = await db.insert(monitoredWorksTable).values({
      title: body.title,
      platform: body.platform,
      listingUrl: body.listingUrl,
      active: body.active ?? true,
    }).returning();
    res.status(201).json(CreateMonitoredWorkResponse.parse(serializeWork(work)));
  } catch (error) {
    next(error);
  }
});

router.patch("/monitor/works/:id", async (req, res, next) => {
  try {
    const { id } = UpdateMonitoredWorkParams.parse(req.params);
    const body = UpdateMonitoredWorkBody.parse(req.body);
    const [work] = await db.update(monitoredWorksTable).set({
      ...body,
      updatedAt: new Date(),
    }).where(eq(monitoredWorksTable.id, id)).returning();
    if (!work) {
      res.status(404).json({ error: "Work not found" });
      return;
    }
    res.json(UpdateMonitoredWorkResponse.parse(serializeWork(work)));
  } catch (error) {
    next(error);
  }
});

router.delete("/monitor/works/:id", async (req, res, next) => {
  try {
    const { id } = DeleteMonitoredWorkParams.parse(req.params);
    const [work] = await db.delete(monitoredWorksTable).where(eq(monitoredWorksTable.id, id)).returning();
    if (!work) {
      res.status(404).json({ error: "Work not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get("/monitor/config", async (_req, res, next) => {
  try {
    const config = await getConfig();
    res.json(GetMonitorConfigResponse.parse({
      discordChannelId: config.discordChannelId,
      discordChannelName: config.discordChannelName,
      intervalMinutes: config.intervalMinutes,
    }));
  } catch (error) {
    next(error);
  }
});

router.patch("/monitor/config", async (req, res, next) => {
  try {
    const body = UpdateMonitorConfigBody.parse(req.body);
    await getConfig();
    const [config] = await db.update(monitorConfigTable).set({
      ...body,
      updatedAt: new Date(),
    }).where(eq(monitorConfigTable.id, 1)).returning();
    res.json(UpdateMonitorConfigResponse.parse({
      discordChannelId: config.discordChannelId,
      discordChannelName: config.discordChannelName,
      intervalMinutes: config.intervalMinutes,
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/monitor/discord/channels", async (_req, res, next) => {
  try {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      res.status(503).json({ error: "Discord bot token is not configured" });
      return;
    }
    const guildsResponse = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!guildsResponse.ok) {
      res.status(503).json({ error: "Discord bot could not list servers" });
      return;
    }
    const guilds = (await guildsResponse.json()) as Array<{ id: string; name: string }>;
    const channels = [];
    for (const guild of guilds) {
      const response = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!response.ok) continue;
      const guildChannels = (await response.json()) as Array<{ id: string; name: string; type: number }>;
      channels.push(...guildChannels
        .filter((channel) => channel.type === 0 || channel.type === 5)
        .map((channel) => ({ id: channel.id, name: channel.name, guildId: guild.id, guildName: guild.name })));
    }
    const config = await getConfig();
    const preferred = channels.find((channel) => channel.name.toLowerCase() === "previw");
    if (!config.discordChannelId && preferred) {
      await db.update(monitorConfigTable).set({
        discordChannelId: preferred.id,
        discordChannelName: `${preferred.guildName} / #${preferred.name}`,
        updatedAt: new Date(),
      }).where(eq(monitorConfigTable.id, 1));
    }
    res.json(ListDiscordChannelsResponse.parse(channels));
  } catch (error) {
    next(error);
  }
});

router.post("/monitor/run", async (_req, res, next) => {
  try {
    const result = await runMonitor();
    res.status(202).json(RunMonitorNowResponse.parse(result));
  } catch (error) {
    logger.error({ err: error }, "Monitor run failed");
    next(error);
  }
});

export default router;