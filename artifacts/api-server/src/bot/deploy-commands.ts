import { REST, Routes } from "discord.js";
import { data as searchData } from "./commands/search.js";
import { data as topData } from "./commands/top.js";
import { data as recomendarData } from "./commands/recomendar.js";
import { data as ajudaData } from "./commands/ajuda.js";
import { data as aleatorioData } from "./commands/aleatorio.js";
import { data as lancamentosData } from "./commands/lancamentos.js";
import { data as favoritosData } from "./commands/favoritos.js";
import { data as compararData } from "./commands/comparar.js";
import { data as autorData } from "./commands/autor.js";
import { data as notificarData } from "./commands/notificar.js";
import { data as listaData } from "./commands/lista.js";
import { data as rankingData } from "./commands/ranking.js";
import { data as perfilData } from "./commands/perfil.js";
import { data as similarData } from "./commands/similar.js";
import { data as buscarData } from "./commands/buscar.js";
import { data as animeData } from "./commands/anime.js";
import { data as noticiasData } from "./commands/noticias.js";
import { data as identificarData } from "./commands/identificar.js";
import { data as temasData } from "./commands/temas.js";
import { data as filmeData } from "./commands/filme.js";
import { data as mangaData } from "./commands/manga.js";
import { data as calendarioData } from "./commands/calendario.js";
import { data as calendario18Data } from "./commands/calendario18.js";
import { data as temporadaData } from "./commands/temporada.js";
import { configurarData, atualizarData, statusData as temporadaStatusData } from "./season-management.js";
import { data as statusData } from "./commands/status.js";
import { data as verificarData } from "./commands/verificar.js";
import { data as assinarData } from "./commands/assinar.js";
import { data as assinar18Data } from "./commands/assinar18.js";
import { data as adminData } from "./commands/admin.js";
import { logger } from "../lib/logger.js";

export async function deployCommands(clientId: string, token: string) {
  const commands = [
    searchData.toJSON(),
    topData.toJSON(),
    recomendarData.toJSON(),
    ajudaData.toJSON(),
    aleatorioData.toJSON(),
    lancamentosData.toJSON(),
    favoritosData.toJSON(),
    compararData.toJSON(),
    autorData.toJSON(),
    notificarData.toJSON(),
    listaData.toJSON(),
    rankingData.toJSON(),
    perfilData.toJSON(),
    similarData.toJSON(),
    buscarData.toJSON(),
    animeData.toJSON(),
    noticiasData.toJSON(),
    identificarData.toJSON(),
    temasData.toJSON(),
    filmeData.toJSON(),
    mangaData.toJSON(),
    calendarioData.toJSON(),
    calendario18Data.toJSON(),
    temporadaData.toJSON(),
    configurarData.toJSON(),
    atualizarData.toJSON(),
    temporadaStatusData.toJSON(),
    statusData.toJSON(),
    verificarData.toJSON(),
    assinarData.toJSON(),
    assinar18Data.toJSON(),
    adminData.toJSON(),
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
