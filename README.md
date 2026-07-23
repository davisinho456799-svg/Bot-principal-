# 🤖 Bot Principal — Discord Manhwa Bot

Bot de Discord focado em manhwas, mangas, animes e novels. Roda em produção no **Render**.

---

## 🚀 Deploy

O bot é hospedado no [Render](https://render.com) como um **Web Service**.

- **Branch de produção:** `bot`
- **Build command:** `pnpm install && pnpm --filter @workspace/api-server run build`
- **Start command:** `pnpm --filter @workspace/api-server run start`

Qualquer push na branch `bot` aciona o redeploy automático no Render (se o auto-deploy estiver ativado).

---

## ⚙️ Variáveis de Ambiente

Configure as seguintes variáveis no painel do Render:

| Variável | Descrição |
|---|---|
| `DISCORD_BOT_TOKEN` | Token do bot no Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ID do aplicativo Discord |
| `DATABASE_URL` | URL de conexão com o banco PostgreSQL |
| `ANILIST_TOKEN` | Token AniList (opcional, para conteúdo +18) |

---

## 📋 Comandos Disponíveis

### 📚 Manhwa / Manga
| Comando | Descrição |
|---|---|
| `/manhwa` | Pesquisa um manhwa com sinopse traduzida e links |
| `/manga` | Pesquisa mangás japoneses |
| `/similar` | Encontra manhwas similares a um título |
| `/recomendar` | Recomendações com filtros de gênero e +18 |
| `/top` | Lista os manhwas mais populares |
| `/aleatorio` | Manhwa aleatório |
| `/lancamentos` | Manhwas em lançamento recente |
| `/autor` | Busca obras por autor |
| `/comparar` | Compara dois manhwas lado a lado |
| `/buscar` | Busca avançada com múltiplos filtros |
| `/temas` | Busca por tema/tag |
| `/identificar` | Identifica um manhwa a partir de imagem ou URL |

### 🎬 Anime / Filme / VN
| Comando | Descrição |
|---|---|
| `/anime` | Pesquisa animes com informações detalhadas |
| `/filme` | Pesquisa filmes de anime |
| `/vn` | Pesquisa visual novels |

### ⭐ Favoritos e Lista
| Comando | Descrição |
|---|---|
| `/favoritos adicionar` | Adiciona um manhwa aos favoritos (com autocomplete) |
| `/favoritos listar` | Mostra sua lista de favoritos |
| `/favoritos remover` | Remove um manhwa dos favoritos |
| `/lista adicionar` | Adiciona à lista de leitura com status |
| `/lista ver` | Visualiza sua lista de leitura |
| `/lista mover` | Muda o status de um item |
| `/lista remover` | Remove da lista de leitura |

### 🔔 Notificações
| Comando | Descrição |
|---|---|
| `/notificar canal` | Configura o canal para avisos de novos capítulos |
| `/notificar status` | Mostra o canal configurado |
| `/notificar desativar` | Desativa as notificações |

> A verificação de novos capítulos acontece automaticamente a cada **2 horas**.

### 📰 Notícias
| Comando | Descrição |
|---|---|
| `/noticias` | Notícias e lançamentos filtrados por gênero |

### 👤 Perfil e Ranking
| Comando | Descrição |
|---|---|
| `/perfil` | Exibe seu perfil de uso |
| `/ranking` | Ranking de usuários mais ativos |

### 🛠️ Admin
| Comando | Descrição |
|---|---|
| `/admin` | Painel administrativo (apenas admins) |

---

## 🗄️ Banco de Dados

Usa **PostgreSQL** com **Drizzle ORM**. Para aplicar mudanças no schema:

```bash
pnpm --filter @workspace/db run push
```

---

## 🛠️ Desenvolvimento Local

```bash
# Instalar dependências
pnpm install

# Rodar em modo desenvolvimento
pnpm --filter @workspace/api-server run dev
```

Certifique-se de ter as variáveis de ambiente configuradas em um arquivo `.env` na raiz do projeto.
