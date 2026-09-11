import { REST, Routes } from "discord.js";
import { logger } from "../lib/logger.js";
import { commandDefinitions } from "./command-registry.js";

export async function deployCommands(
  clientId: string,
  token: string,
  guildIds: string[] = [],
) {
  const commandsByName = new Map<string, (typeof commandDefinitions)[number]>();
  for (const command of commandDefinitions) {
    if (commandsByName.has(command.name)) {
      logger.warn({ commandName: command.name }, "Comando duplicado removido antes do registro");
    }
    commandsByName.set(command.name, command);
  }
  const commands = [...commandsByName.values()];
  const rest = new REST().setToken(token);
  const configuredGuildId = process.env.DISCORD_GUILD_ID?.trim() || null;
  const guildCommandIds = configuredGuildId
    ? [configuredGuildId]
    : [];
  const guildIdsToClear = guildIds.filter((guildId) => guildId !== configuredGuildId);

  try {
    logger.info(
      {
        count: commands.length,
        scope: configuredGuildId ? "guild" : "global",
        configuredGuildId,
      },
      "Registrando slash commands...",
    );
    if (configuredGuildId) {
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
    }
    await Promise.all(
      guildCommandIds.map((guildId) =>
        rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands }),
      ),
    );
    await Promise.all(
      guildIdsToClear.map((guildId) =>
        rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] }),
      ),
    );
    logger.info(
      { guildCount: guildCommandIds.length, clearedGuildCount: guildIdsToClear.length },
      "Slash commands registrados com sucesso.",
    );
  } catch (err) {
    logger.error({ err }, "Erro ao registrar slash commands");
    throw err;
  }
}
