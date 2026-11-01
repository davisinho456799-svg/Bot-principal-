# Diagnóstico do monitor: da página até a mensagem no Discord

**Escopo:** branch `feature/light-bot-mode`, revisada em 25/09/2026. Este documento registra o caminho da detecção até o Discord e a causa provável das imagens extras.

## Resumo

O envio monta um único arquivo PNG por mensagem (`files[0]`). Portanto, quando a imagem do Discord mostra vários quadros lado a lado, eles já estavam dentro do PNG produzido antes do envio; não são anexos separados criados pelo Discord.

O modo de navegador escolhe um card de capítulo e uma URL de miniatura, mas a captura usa a área inteira do card renderizado. Se a página renderiza imagens secundárias dentro do mesmo card, elas entram no PNG.

A correção mantém a espera da miniatura principal, associa cada card à URL escolhida e, antes do screenshot, oculta as outras imagens, fundos e pseudo-elementos do card. O texto do card permanece. Nada é removido da página de origem: a alteração existe apenas no DOM da página temporária aberta pelo navegador.

## Fluxo completo

### 1. Configuração

Uma obra monitorada guarda título, plataforma e URL da página de listagem. A configuração do monitor guarda o canal do Discord. O serviço atende Lezhin, Toomics e Toptoon.

O monitor pode ser iniciado pelo agendador, pela rota `POST /monitor/run` ou pelo comando `/monitor verificar`. Também existem caminhos para teste (`/monitor teste`) e reenvio de capítulo (`/monitor reenviar`).

### 2. Leitura da página

`fetchListing()` tenta abrir a página com Playwright. Quando encontra cards, os candidatos incluem número, URL da miniatura, data quando disponível e um identificador interno para recapturar o card.

Se o navegador falhar ou não encontrar cards, o fluxo tenta o parser específico da plataforma e depois o parser genérico de HTML. Esses parsers usam as imagens e dados presentes no HTML, sem capturar a página renderizada.

### 3. Detecção do card

`findRenderedChapters()` examina elementos com números, rótulos ou links de capítulo. Para cada número, escolhe o candidato melhor pontuado e sobe até o primeiro contêiner que parece ser um card válido. A subida para nesse primeiro card para não capturar a lista inteira.

O código também escolhe uma primeira mídia utilizável e guarda sua `thumbnailUrl`. Essa URL é usada tanto para identificar a mídia principal quanto para o fallback.

### 4. Comparação com o estado anterior

`runMonitor()` compara os capítulos encontrados com os já registrados no banco. Na primeira verificação, salva uma linha de base e não publica os capítulos que já estavam listados.

Nas verificações seguintes, capítulos conhecidos são descartados, capítulos antigos ou anteriores à criação do monitor não são publicados e somente os capítulos novos seguem para envio.

### 5. Captura

`captureGroups()` agrupa cards próximos quando cabem juntos na área permitida. Um grupo com vários capítulos pode conter vários cards de propósito.

`captureGroup()`:

1. rola até cada card;
2. espera a URL de miniatura selecionada, e não apenas qualquer imagem;
3. falha se a mídia principal não puder ser identificada;
4. oculta imagens, fundos e pseudo-elementos secundários;
5. captura apenas o retângulo dos cards restantes.

Assim, vários capítulos novos continuam podendo ser agrupados em uma captura. Para um único capítulo, as imagens extras dentro daquele card deixam de aparecer.

Se a captura do navegador falhar, o serviço usa `buildStrip()`, que baixa uma `thumbnailUrl` por capítulo e compõe uma imagem alternativa com Sharp. Nesse modo também há uma imagem por capítulo.

### 6. Cabeçalho e envio

`postStrip()` tenta adicionar o cabeçalho “NEW CHAPTERS” ao PNG. Se essa composição falhar, usa o fallback Sharp. O envio ao Discord inclui somente `files[0]`; quando há várias partes, elas são enviadas em mensagens separadas.

O histórico registra o modo usado (`browser+banner`, `sharp+banner` ou `none`). Esse campo distingue uma captura renderizada pelo navegador de uma imagem composta a partir da URL de fallback.

### 7. Persistência

Depois do envio, o monitor grava capítulos publicados, histórico, atividade recente e o horário/status da obra. Se uma execução falha antes de completar o processamento, o status fica como falha e a execução seguinte pode tentar novamente.

## Causa identificada e correção

O problema estava no fato de a captura do navegador enquadrar o card completo, enquanto o envio mandava corretamente apenas um arquivo. A espera de mídia também havia sido aumentada de 8 para 30 segundos, o que podia dar tempo para painéis secundários carregarem antes do screenshot.

A correção:

- associa cada card à miniatura principal escolhida;
- espera exatamente essa mídia estar carregada;
- mantém a miniatura principal e o texto;
- oculta imagens, backgrounds e pseudo-elementos secundários, inclusive mídias derivadas de `data-ep_thumb2` e `data-ep_thumb3`;
- usa erro explícito para acionar o fallback quando a miniatura principal não puder ser isolada;
- não faz nenhuma requisição de exclusão nem altera o site de origem.

Há um teste de regressão com uma miniatura principal, imagens secundárias, background CSS e pseudo-elemento. Ele confirma que somente a imagem selecionada permanece visível e que o texto do capítulo é preservado.

## Limitações da confirmação

A verificação local confirma a lógica de isolamento e os tipos do projeto. Ainda não há uma URL pública da página problemática, logs de uma entrega específica ou credenciais de Discord disponíveis neste workspace. Portanto, não é possível afirmar reprodução em produção nem validar uma mensagem real no canal.