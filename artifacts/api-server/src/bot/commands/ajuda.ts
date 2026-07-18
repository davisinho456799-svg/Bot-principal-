import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("ajuda")
  .setDescription("Lista todos os comandos do bot e suas funções");

export async function execute(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle("📖 Comandos do Bot")
    .setColor(0x7b68ee)
    .setDescription(
      "Comandos disponíveis — use `/ajuda` para ver esta lista a qualquer momento.\n" +
      "**Seções:** [📚 Manhwa/Manga](#manhwa) • [📺 Anime](#anime) • [🎮 Visual Novels](#vn) • [⚙️ Config](#config)"
    );

  // ── Manhwa / Manga ──────────────────────────────────────────────────────────
  embed.addFields(
    {
      name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📚 MANHWA / MANGA",
      value:
        "Fontes: 🟣 AniList • 🟠 MangaDex • 🟡 Comick • 🔵 MangaUpdates • 🔴 MyAnimeList",
      inline: false,
    },
    {
      name: "🔍 /manhwa <título>",
      value:
        "Pesquisa em até **5 fontes simultâneas** com ranqueamento automático.\n" +
        "Exibe: sinopse PT-BR, nota, gêneros, capítulos, status, títulos alternativos e links dos sites BR de leitura.\n" +
        "Use `descricao:` para descrever em português e o bot encontra o mais compatível.",
      inline: false,
    },
    {
      name: "🏆 /topmanhwa",
      value: "Lista os **10 manhwas mais bem avaliados** do AniList.",
      inline: false,
    },
    {
      name: "🎭 /recomendar",
      value:
        "Recomenda manhwas por **até 5 gêneros** (Ação, Romance, Fantasia, Reencarnação, Survival…).",
      inline: false,
    },
    {
      name: "🎲 /aleatorio",
      value: "Retorna um **manhwa aleatório** bem avaliado.",
      inline: false,
    },
    {
      name: "📡 /lancamentos",
      value: "Manhwas **em lançamento** ordenados por popularidade.",
      inline: false,
    },
    {
      name: "⭐ /favoritos [adicionar|listar|remover]",
      value: "Gerencie sua lista pessoal de manhwas favoritos.",
      inline: false,
    },
    {
      name: "⚔️ /comparar <manhwa1> <manhwa2>",
      value: "Compara dois manhwas lado a lado com 🏆 no critério vencedor.",
      inline: false,
    },
    {
      name: "✍️ /autor <nome>",
      value: "Busca um autor/artista e lista toda a obra dele.",
      inline: false,
    },
    {
      name: "🎯 /similar <titulo>",
      value: "Encontra manhwas parecidos baseado em recomendações do AniList.",
      inline: false,
    },
    {
      name: "🔎 /buscar [genero] [status] [ano] [nota] [tipo]",
      value: "Busca avançada com filtros: gênero, status, ano, nota mínima, tipo (Manhwa 🇰🇷 / Manhua 🇨🇳 / Manga 🇯🇵).",
      inline: false,
    },
    {
      name: "📋 /lista [adicionar|ver|mover|remover]",
      value: "Lista de leitura pessoal com status: Lendo, Concluído, Planejo Ler, Pausado, Abandonado.",
      inline: false,
    },
    {
      name: "🏆 /ranking",
      value: "Top 10 dos manhwas mais favoritados por todos os usuários.",
      inline: false,
    },
    {
      name: "📊 /perfil [@usuário]",
      value: "Estatísticas de leitura: títulos, favoritos, nota média, gêneros preferidos.",
      inline: false,
    },
  );

  // ── Anime ───────────────────────────────────────────────────────────────────
  embed.addFields(
    {
      name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📺 ANIME",
      value:
        "Fontes: 🟣 AniList • 🔴 MyAnimeList • 🔵 Kitsu • 🟤 AniDB (ver configuração abaixo)",
      inline: false,
    },
    {
      name: "📺 /anime titulo:<nome>",
      value:
        "Pesquisa um anime em **4 fontes simultâneas** com autocomplete.\n" +
        "Exibe: sinopse PT-BR, episódios, tipo (TV/Movie/OVA), temporada, estúdios, links de streaming global e **7 sites PT-BR** (AnimeFire, GoAnimes, Goyabu, BetterAnime…).",
      inline: false,
    },
    {
      name: "📺 /anime descricao:<texto>",
      value:
        "Descreva o anime em português e o bot encontra o mais compatível.\n" +
        "Ex: *\"dois irmãos alquimistas que procuram a pedra filosofal\"*\n" +
        "Mostra **% de compatibilidade** para cada resultado.",
      inline: false,
    },
  );

  // ── Visual Novels ───────────────────────────────────────────────────────────
  embed.addFields(
    {
      name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🎮 VISUAL NOVELS",
      value: "Fonte: 🔵 VNDB (Visual Novel Database)",
      inline: false,
    },
    {
      name: "🎮 /vn <titulo>",
      value:
        "Pesquisa visual novels no **VNDB** com autocomplete.\n" +
        "Exibe: sinopse PT-BR, nota, votos, **duração estimada** (ex: Médio ~10–30h), desenvolvedora, idiomas disponíveis com bandeiras, tags sem spoiler e links para compra (Steam, Johren, MangaGamer…).",
      inline: false,
    },
  );

  // ── Notificações ────────────────────────────────────────────────────────────
  embed.addFields(
    {
      name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔔 NOTIFICAÇÕES",
      value: "*(Requer permissão de Gerenciar Canais)*",
      inline: false,
    },
    {
      name: "🔔 /notificar canal <#canal>",
      value: "Define o canal para avisos de novos capítulos dos manhwas favoritos. Verificação a cada **2 horas**.",
      inline: false,
    },
    {
      name: "📭 /notificar status  •  🔕 /notificar desativar",
      value: "Vê o canal configurado ou desativa as notificações.",
      inline: false,
    },
  );

  // ── Configuração AniDB ──────────────────────────────────────────────────────
  embed.addFields(
    {
      name: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚙️ CONFIGURAÇÃO — AniDB (opcional)",
      value:
        "Por padrão, o AniDB funciona como **fallback de busca de títulos** (sem detalhes).\n" +
        "Para ativar sinopse, score, episódios e capa do AniDB:\n\n" +
        "**1.** Acesse https://anidb.net/software/add\n" +
        "**2.** Registre um novo client (gratuito, aprovação em minutos)\n" +
        "**3.** Adicione às variáveis de ambiente do bot:\n" +
        "```\nANIDB_CLIENT=seu_client_name\nANIDB_CLIENT_VER=1\n```\n" +
        "⚠️ **Limite:** 1 req/2s e 10 req/sessão (imposto pelo AniDB)",
      inline: false,
    },
    {
      name: "📖 /ajuda",
      value: "Exibe esta mensagem.",
      inline: false,
    },
  );

  embed
    .addFields({
      name: "🇧🇷 Sites de leitura BR (manhwa/manga)",
      value:
        "BlackoutComics • Hiper.cool • TiaManhwa • NexusToons • InkApk • ReMangas • MangaHost • UnionMangas • MangaLivre",
      inline: false,
    })
    .setFooter({
      text: "Dados: AniList • MangaDex • Comick • MangaUpdates • MAL • Kitsu • AniDB • VNDB • Sinopses traduzidas automaticamente",
    });

  await interaction.reply({ embeds: [embed] });
}
