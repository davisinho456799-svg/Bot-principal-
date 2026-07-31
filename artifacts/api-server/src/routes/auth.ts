import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { webAdminsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "fallback-secret-change-me";

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email e senha são obrigatórios." });
    return;
  }

  const [admin] = await db
    .select()
    .from(webAdminsTable)
    .where(eq(webAdminsTable.email, email.toLowerCase()))
    .limit(1);

  if (!admin) {
    res.status(401).json({ error: "Credenciais inválidas." });
    return;
  }

  const valid = await bcrypt.compare(password, admin.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Credenciais inválidas." });
    return;
  }

  const token = jwt.sign(
    { id: admin.id, email: admin.email, name: admin.name },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, name: admin.name });
});

// GET /api/auth/me
router.get("/me", async (req, res) => {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Não autenticado." });
    return;
  }

  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as {
      id: number;
      email: string;
      name: string;
    };
    res.json({ id: payload.id, email: payload.email, name: payload.name });
  } catch {
    res.status(401).json({ error: "Token inválido ou expirado." });
  }
});

export default router;
