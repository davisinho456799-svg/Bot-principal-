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
  const connectedGuildIds = [...new Set(guildIds.filter(Boolean))];
  const guildCommandIds = configuredGuildId
    ? [configuredGuildId]
    : connectedGuildIds;
  const guildIdsToClear = connectedGuildIds.filter((guildId) => !guildCommandIds.includes(guildId));
  const useGuildCommands = guildCommandIds.length > 0;

  try {
    logger.info(
      {
        count: commands.length,
        scope: useGuildCommands ? "guild" : "global",
        configuredGuildId,
        guildCommandIds,
      },
      "Registrando slash commands...",
    );
    if (useGuildCommands) {
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
