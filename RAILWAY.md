# Deploy no Railway

O projeto roda no Railway como um único serviço:

- o painel React é compilado para `artifacts/chapter-monitor/dist/public`;
- o servidor Express serve o painel e a API no mesmo domínio;
- o agendador do monitor permanece ativo no processo da API;
- o PostgreSQL do Railway fornece `DATABASE_URL`.

## Variáveis obrigatórias

Configure no serviço do Railway:

```text
DATABASE_URL
DISCORD_BOT_TOKEN
SESSION_SECRET
NODE_ENV=production
SERVE_FRONTEND=true
```

O Railway injeta `PORT` automaticamente. Não fixe esse valor nas variáveis.

## Primeiro deploy

1. Crie um serviço a partir do repositório GitHub.
2. Adicione um PostgreSQL ao projeto Railway.
3. Cadastre as variáveis obrigatórias no serviço da aplicação.
4. Use o `railway.json` da raiz para build, start e healthcheck.
5. Depois do primeiro deploy, aplique o schema do banco uma vez:

```bash
pnpm --filter @workspace/db run push
```

O comando precisa ser executado com a mesma `DATABASE_URL` do PostgreSQL do Railway. Não coloque a URL no repositório.

## Rotas

- `/` — dashboard
- `/works` — obras monitoradas
- `/settings` — configuração do Discord
- `/api/healthz` — healthcheck do Railway

O bot precisa estar no servidor do Discord com permissão para visualizar o canal `previw` e enviar mensagens.

## Comandos do Discord

O bot registra comandos slash automaticamente em todos os servidores onde está instalado. Para cadastrar uma obra sem abrir o painel:

```text
/manhwa adicionar link:https://... nome:Nome da obra
```

O domínio identifica automaticamente Lezhin, Toomics ou Toptoon. Se o domínio não for reconhecido, informe também a opção `plataforma`.

Para conferir a lista ativa:

```text
/manhwa listar
```

Os comandos exigem a permissão **Gerenciar servidor** e gravam na mesma watchlist usada pelo painel web.