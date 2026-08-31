# Lavalink no Railway

Crie um segundo serviço no Railway apontando para a pasta `lavalink` e usando
o Dockerfile local.

No serviço Lavalink, configure:

- `PORT`: fornecida pelo Railway.
- `PASSWORD`: uma senha definida por você.

No serviço do bot, configure:

- `LAVALINK_HOST`: domínio do serviço Lavalink, sem `https://`.
- `LAVALINK_PORT`: `443` quando usar o domínio público HTTPS do Railway.
- `LAVALINK_PASSWORD`: o mesmo valor de `PASSWORD`.
- `LAVALINK_SECURE`: `true` com domínio público HTTPS; `false` na rede privada.
- `LAVALINK_SEARCH_PLATFORM`: `ytsearch` ou `ytmsearch`.