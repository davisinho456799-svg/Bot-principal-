---
name: Bot principal e linha main
description: Qual linha do projeto contém o bot principal e o comando calendário
---

O bot principal é a linha que contém os comandos completos de produção, incluindo `/calendario`, `/calendario18`, assinaturas e serviços de notificação. A linha `main` é uma versão diferente e mais reduzida, com `/lancamentos` no lugar do calendário real.

**Why:** As duas linhas têm históricos e estruturas de banco diferentes; tratar `main` como fonte do bot principal pode fazer uma manutenção alterar o comando errado ou remover comandos registrados no Discord.

**How to apply:** Para correções do bot principal, confirmar que o workspace está na linha do bot principal antes de editar e evitar trocar toda a linha sem preservar as atualizações dela.