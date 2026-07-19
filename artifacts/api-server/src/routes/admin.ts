import { Router, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  usageLogsTable,
  adminUsersTable,
  favoritosTable,
  webAdminsTable,
} from "@workspace/db/schema";
import { eq, desc, sql } from "drizzle-orm";

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "fallback-secret-change-me";

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Não autenticado." });
    return;
  }
  try {
    jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido." });
  }
}

router.use(requireAuth);

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────

router.get("/stats", async (_req, res) => {
  const [{ totalComandos }] = await db
    .select({ totalComandos: sql<number>`count(*)::int` })
    .from(usageLogsTable);

  const [{ totalUsuarios }] = await db
    .select({
      totalUsuarios: sql<number>`count(distinct ${usageLogsTable.discordUserId})::int`,
    })
    .from(usageLogsTable);

  const [{ totalFavoritos }] = await db
    .select({ totalFavoritos: sql<number>`count(*)::int` })
    .from(favoritosTable);

  const topRows = await db
    .select({
      command: usageLogsTable.command,
      total: sql<number>`count(*)::int`,
    })
    .from(usageLogsTable)
    .groupBy(usageLogsTable.command)
    .orderBy(desc(sql`count(*)`))
    .limit(1);

  res.json({
    totalComandos: totalComandos ?? 0,
    totalUsuarios: totalUsuarios ?? 0,
    totalFavoritos: totalFavoritos ?? 0,
    comandoMaisUsado: topRows[0]?.command ?? null,
  });
});

// ─── GET /api/admin/logs ──────────────────────────────────────────────────────

router.get("/logs", async (req, res) => {
  const { userId, command, limit = "50" } = req.query as {
    userId?: string;
    command?: string;
    limit?: string;
  };

  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  let query = db
    .select()
    .from(usageLogsTable)
    .orderBy(desc(usageLogsTable.createdAt))
    .limit(lim)
    .$dynamic();

  if (userId) query = query.where(eq(usageLogsTable.discordUserId, userId));
  if (command) query = query.where(eq(usageLogsTable.command, command));

  const rows = await query;
  res.json(rows);
});

// ─── GET /api/admin/usuarios ──────────────────────────────────────────────────

router.get("/usuarios", async (_req, res) => {
  const rows = await db
    .select({
      discordUserId: usageLogsTable.discordUserId,
      discordUsername: usageLogsTable.discordUsername,
      total: sql<number>`count(*)::int`,
      ultimoUso: sql<string>`max(${usageLogsTable.createdAt})`,
    })
    .from(usageLogsTable)
    .groupBy(usageLogsTable.discordUserId, usageLogsTable.discordUsername)
    .orderBy(desc(sql`count(*)`))
    .limit(50);

  res.json(rows);
});

// ─── GET /api/admin/bot-admins ────────────────────────────────────────────────

router.get("/bot-admins", async (_req, res) => {
  const rows = await db
    .select()
    .from(adminUsersTable)
    .orderBy(adminUsersTable.addedAt);
  res.json(rows);
});

// ─── POST /api/admin/bot-admins ───────────────────────────────────────────────

router.post("/bot-admins", async (req, res) => {
  const { discordUserId, discordUsername } = req.body as {
    discordUserId?: string;
    discordUsername?: string;
  };

  if (!discordUserId || !discordUsername) {
    res.status(400).json({ error: "discordUserId e discordUsername são obrigatórios." });
    return;
  }

  const [inserted] = await db
    .insert(adminUsersTable)
    .values({ discordUserId, discordUsername, addedBy: "painel-web" })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    res.status(409).json({ error: "Usuário já é admin." });
    return;
  }

  res.status(201).json(inserted);
});

// ─── DELETE /api/admin/bot-admins/:discordUserId ──────────────────────────────

router.delete("/bot-admins/:discordUserId", async (req, res) => {
  const { discordUserId } = req.params;

  await db
    .delete(adminUsersTable)
    .where(eq(adminUsersTable.discordUserId, discordUserId!));

  res.json({ ok: true });
});

// ─── Rota de setup: cria o primeiro admin do painel web ───────────────────────
// Só funciona se não houver nenhum admin ainda.

router.post("/setup", async (req, res) => {
  const existing = await db.select().from(webAdminsTable).limit(1);
  if (existing.length > 0) {
    res.status(403).json({ error: "Setup já foi realizado." });
    return;
  }

  const { email, password, name } = req.body as {
    email?: string;
    password?: string;
    name?: string;
  };

  if (!email || !password || !name) {
    res.status(400).json({ error: "email, password e name são obrigatórios." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [admin] = await db
    .insert(webAdminsTable)
    .values({ email: email.toLowerCase(), passwordHash, name })
    .returning();

  res.status(201).json({ id: admin!.id, email: admin!.email, name: admin!.name });
});

export default router;
