import { ChatInputCommandInteraction } from "discord.js";
import { db } from "@workspace/db";
import { adminUsersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

export async function isAdmin(userId: string): Promise<boolean> {
  const result = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.discordUserId, userId))
    .limit(1);
  return result.length > 0;
}

export async function requireAdmin(
  interaction: ChatInputCommandInteraction
): Promise<boolean> {
  const admin = await isAdmin(interaction.user.id);
  if (!admin) {
    await interaction.reply({
      content: "❌ Você não tem permissão para usar este comando.",
      ephemeral: true,
    });
    return false;
  }
  return true;
}
