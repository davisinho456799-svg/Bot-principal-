---
name: Anexos e Git
description: Cuidados com arquivos enviados como anexos durante manutenção do projeto
---

Arquivos enviados para o Repl podem aparecer em `attached_assets` e ser incluídos em commits automáticos ou no próximo push. Antes de enviar alterações ao remoto, revisar os arquivos rastreados e manter imagens de conversa fora do repositório quando não forem assets do produto.

**Why:** Capturas de tela anexadas para depuração não são necessariamente arquivos do produto e podem conter informações da interface ou do ambiente.

**How to apply:** Verificar `git status`, `git ls-files 'attached_assets/*'` e os commits pendentes antes de `git push`; usar `.gitignore` para impedir novas inclusões acidentais.