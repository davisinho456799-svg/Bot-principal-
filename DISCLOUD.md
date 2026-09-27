# Deploy na Discloud

O bot usa PostgreSQL padrão. Na configuração atual, a URL da Discloud fica na
variável `NEW_DATABASE_URL`; o entrypoint converte essa variável internamente
para `DATABASE_URL`, que é o nome usado pelo código e pelo Drizzle.

## Variáveis obrigatórias

Configure na Discloud:

- `NEW_DATABASE_URL` — URL completa do banco PostgreSQL da Discloud
- `NEON_DATABASE_URL` — URL do banco antigo, somente durante a cópia
- `DISCORD_BOT_TOKEN` — token do bot do Discord

Não coloque esses valores no GitHub nem no `discloud.config`.

## Banco e alterações do schema

O comando `BUILD` do `discloud.config` executa:

```bash
pnpm --filter @workspace/db run push
```

Esse comando compara o schema em `lib/db/src/schema` com o PostgreSQL indicado
por `NEW_DATABASE_URL` e cria/aplica as tabelas necessárias antes de compilar o
bot. No processo de build, essa variável é mapeada para `DATABASE_URL`.

```bash
pnpm --filter @workspace/db run push
```

Para uma base vazia, isso cria todas as tabelas do schema atual. Para uma base
que já contém dados, faça um backup antes de aplicar alterações estruturais.
O script `push` não deve ser substituído por `push-force` sem revisar o plano
de mudanças do Drizzle.

## Cópia única do Neon

Como o endereço do banco da Discloud é interno, a cópia precisa ser executada
dentro da própria Discloud. Para fazer isso:

1. Configure também `NEON_DATABASE_URL` na Discloud.
2. Configure temporariamente `COPY_DATABASE_FROM_NEON=true`.
3. Faça um deploy. O build cria o schema e copia os registros.
4. Depois que terminar, remova `COPY_DATABASE_FROM_NEON` e
   `NEON_DATABASE_URL`, e faça outro deploy.

O copiador verifica se o banco destino está vazio e aborta se encontrar dados,
em vez de sobrescrevê-los.