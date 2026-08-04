import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db, errorLogsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const RETENTION_DAYS = 30;
const MAX_ERRORS_PER_GUILD = 500;

export type BotErrorInput = {
  source: string;
  errorCode: string;
  error: unknown;
  discordGuildId?: string | null;
  discordUserId?: string | null;
  command?: string | null;
  context?: Record<string, unknown> | null;
};

function describeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack ?? null };
  }

  if (typeof error === "string") {
    return { message: error, stack: null };
  }

  try {
    return { message: JSON.stringify(error), stack: null };
  } catch {
    return { message: "Erro não serializável", stack: null };
  }
}

function redactSensitive(value: string): string {
  return value
    .replace(
      /((?:token|secret|password|passwd|authorization|api[-_]?key|client[-_]?secret)\s*[:=]\s*)([^\s,;"']+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /([?&](?:token|secret|key|password|api_key|apikey)=)[^&\s]+/gi,
      "$1[REDACTED]",
    );
}

function redactContext(context: Record<string, unknown> | null): Record<string, unknown> {
  if (!context) return {};

  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => {
      const sensitiveKey =
        /token|secret|password|passwd|authorization|api[-_]?key|client[-_]?secret/i.test(key);
      if (sensitiveKey) return [key, "[REDACTED]"];
      if (typeof value === "string") return [key, redactSensitive(value).slice(0, 8000)];
      return [key, value];
    }),
  );
}

/**
 * Persiste um erro no Neon sem deixar o registro de erro derrubar o bot.
 * A retenção é limitada para o histórico não crescer indefinidamente.
 */
export async function recordBotError(input: BotErrorInput): Promise<number | null> {
  const { message, stack } = describeError(input.error);

  try {
    const [created] = await db
      .insert(errorLogsTable)
      .values({
        discordGuildId: input.discordGuildId ?? null,
        discordUserId: input.discordUserId ?? null,
        command: input.command ?? null,
        source: input.source,
        errorCode: input.errorCode,
        message: redactSensitive(message).slice(0, 4000),
        context: {
          ...redactContext(input.context ?? null),
          stack: stack ? redactSensitive(stack).slice(0, 8000) : null,
        },
      })
      .returning({ id: errorLogsTable.id });

    await db
      .delete(errorLogsTable)
      .where(
        lt(
          errorLogsTable.createdAt,
          new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000),
        ),
      );

    if (created && input.discordGuildId) {
      const oldRows = await db
        .select({ id: errorLogsTable.id })
        .from(errorLogsTable)
        .where(eq(errorLogsTable.discordGuildId, input.discordGuildId))
        .orderBy(desc(errorLogsTable.createdAt))
        .offset(MAX_ERRORS_PER_GUILD);

      if (oldRows.length > 0) {
        await db
          .delete(errorLogsTable)
          .where(inArray(errorLogsTable.id, oldRows.map((row) => row.id)));
      }
    }

    return created?.id ?? null;
  } catch (loggingError) {
    logger.warn({ loggingError, source: input.source }, "Não foi possível salvar histórico de erro");
    return null;
  }
}

export function errorContext(error: unknown): Record<string, unknown> {
  const { stack } = describeError(error);
  return stack ? { stack: stack.slice(0, 8000) } : {};
}