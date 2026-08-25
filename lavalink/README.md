# Lavalink no Railway

Crie um segundo serviço Railway apontando para a pasta lavalink e faça o deploy usando o Dockerfile local.

Variáveis do serviço Lavalink:

- PORT: fornecida pelo Railway; não fixe o valor no arquivo.
- PASSWORD: uma senha definida no Railway.

Depois configure no serviço do bot:

- LAVALINK_HOST: domínio público ou privado do serviço Lavalink, sem https://
- LAVALINK_PORT: 443 se usar o domínio público HTTPS do Railway; caso use rede privada, a porta interna do serviço.
- LAVALINK_PASSWORD: o mesmo valor de PASSWORD.
- LAVALINK_SECURE: true para domínio público HTTPS; false na rede privada.
- LAVALINK_SEARCH_PLATFORM: ytsearch ou ytmsearch.
