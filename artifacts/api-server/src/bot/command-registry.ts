import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import * as ajudaCommand from "./commands/ajuda.js";
import * as autorCommand from "./commands/autor.js";
import * as animeCommand from "./commands/anime.js";
import * as mangaCommand from "./commands/manga.js";
import * as buscarCommand from "./commands/buscar.js";
import * as listaCommand from "./commands/lista.js";
import * as favoritosCommand from "./commands/favoritos.js";
import * as noticiasCommand from "./commands/noticias.js";
import * as temporadaCommand from "./commands/temporada.js";
import * as statusCommand from "./commands/status.js";
import * as searchCommand from "./commands/search.js";
import * as topCommand from "./commands/top.js";
import * as recomendarCommand from "./commands/recomendar.js";
import * as aleatorioCommand from "./commands/aleatorio.js";
import * as lancamentosCommand from "./commands/lancamentos.js";
import * as compararCommand from "./commands/comparar.js";
import * as notificarCommand from "./commands/notificar.js";
import * as rankingCommand from "./commands/ranking.js";
import * as perfilCommand from "./commands/perfil.js";
import * as similarCommand from "./commands/similar.js";
import * as identificarCommand from "./commands/identificar.js";
import * as temasCommand from "./commands/temas.js";
import * as filmeCommand from "./commands/filme.js";
import * as calendarioCommand from "./commands/calendario.js";
import * as calendario18Command from "./commands/calendario18.js";
import * as historicoCommand from "./commands/historico.js";
import * as verificarCommand from "./commands/verificar.js";
import * as assinarCommand from "./commands/assinar.js";
import * as assinar18Command from "./commands/assinar18.js";
import * as adminCommand from "./commands/admin.js";
import * as limparCommand from "./commands/limpar.js";
import {
  executeManhwaCommand,
  monitorCommandDefinition,
} from "../services/discord-command-service.js";

export type BotCommand = {
  data: { name: string; toJSON?: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
};

export type CommandDefinition = {
  name: string;
  [key: string]: unknown;
};

const commandModules: BotCommand[] = [
  searchCommand,
  topCommand,
  recomendarCommand,
  ajudaCommand,
  aleatorioCommand,
  lancamentosCommand,
  favoritosCommand,
  compararCommand,
  autorCommand,
  notificarCommand,
  listaCommand,
  rankingCommand,
  perfilCommand,
  similarCommand,
  buscarCommand,
  animeCommand,
  noticiasCommand,
  identificarCommand,
  temasCommand,
  filmeCommand,
  mangaCommand,
  calendarioCommand,
  calendario18Command,
  temporadaCommand,
  { data: temporadaCommand.configurarData, execute: temporadaCommand.configurarCommand.execute },
  { data: temporadaCommand.atualizarData, execute: temporadaCommand.atualizarCommand.execute },
  { data: temporadaCommand.temporadaStatusData, execute: temporadaCommand.temporadaStatusCommand.execute },
  statusCommand,
  historicoCommand,
  verificarCommand,
  assinarCommand,
  assinar18Command,
  adminCommand,
  limparCommand,
  { data: monitorCommandDefinition, execute: executeManhwaCommand },
];

export const commandRegistry = new Map<string, BotCommand>(
  commandModules.map((command) => [command.data.name, command]),
);

export const commandDefinitions: CommandDefinition[] = commandModules.map(({ data }) =>
  (typeof data.toJSON === "function" ? data.toJSON() : data) as CommandDefinition,
);
