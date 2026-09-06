import { REST, Routes } from "discord.js";
import { data as ajudaData } from "./commands/ajuda.js";
import { data as autorData } from "./commands/autor.js";
import { data as animeData } from "./commands/anime.js";
import { data as mangaData } from "./commands/manga.js";
import { data as buscarData } from "./commands/buscar.js";
import { data as listaData } from "./commands/lista.js";
import { data as favoritosData } from "./commands/favoritos.js";
import { data as noticiasData } from "./commands/noticias.js";
import { data as temporadaData } from "./commands/temporada.js";
import { data as statusData } from "./commands/status.js";
import { logger } from "../lib/logger.js";
import { manhwaCommandDefinition } from "../services/discord-command-service.js";

export async function deployCommands(clientId: string, token: string) {
  const commands = [
    ajudaData.toJSON(),
    autorData.toJSON(),
    animeData.toJSON(),
    mangaData.toJSON(),
    buscarData.toJSON(),
    listaData.toJSON(),
    favoritosData.toJSON(),
    noticiasData.toJSON(),
    temporadaData.toJSON(),
    statusData.toJSON(),
    manhwaCommandDefinition,
  ];
  const rest = new REST().setToken(token);

  try {
    logger.info({ count: commands.length }, "Registrando slash commands...");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    logger.info("Slash commands registrados com sucesso.");
  } catch (err) {
    logger.error({ err }, "Erro ao registrar slash commands");
    throw err;
  }
}
