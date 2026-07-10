# ZapGrupos

Agendador de mensagens para **grupos** do WhatsApp. Feito para rodar em uma VPS via **EasyPanel** (Docker). Foco: agendamento, envio imediato manual, texto, foto/vídeo, áudio como nota de voz (gravado "na hora"), enquetes e menção a todos.

---

## O que ele faz

- **Agenda** mensagens para uma data/hora, ou **dispara agora**.
- Envia para **vários grupos de uma vez**, um por vez, com pausa aleatória entre eles.
- Tipos de conteúdo:
  - **Texto**
  - **Foto / vídeo** (com legenda opcional)
  - **Áudio** enviado como **nota de voz (PTT)** — aparece como se você tivesse gravado na hora, com o status "gravando áudio…" antes.
  - **Enquete** (2 a 12 opções, resposta única ou múltipla).
- **Campanhas**: sequências de mensagens de vários dias, reutilizáveis, lançadas para os grupos que você escolher.
- **Simular envio manual**: mostra "digitando…" / "gravando…" e espera um tempo natural, proporcional ao tamanho do conteúdo, antes de enviar.
- **Mencionar todos**: notifica o grupo inteiro sem poluir o texto com dezenas de @.
- **Repetição**: diária ou semanal, no mesmo horário.
- **Fila** com status de cada envio (agendada, enviando, enviada, parcial, falhou) e relatório por grupo.
- **Sinal no celular** (opcional): avisos via ntfy.sh quando o WhatsApp cair/reconectar.

---

## Deploy no EasyPanel

### 1. Criar o app

1. No EasyPanel, crie um **App** no seu projeto.
2. Em **Source**, aponte para este repositório do GitHub (`rwadriel/zapgrupos`, branch `main`).
3. Em **Build**, escolha **Dockerfile** (ele está na raiz do repositório).

### 2. Variáveis de ambiente (aba Environment)

```
ZAPGRUPOS_SENHA=escolha-uma-senha-forte
ZG_HEARTBEAT_NTFY_TOPIC=seu-topico-ntfy-secreto
```

- `ZAPGRUPOS_SENHA` — **obrigatória**: o painel fica exposto na internet; sem senha, qualquer pessoa que descobrir a URL controla o seu WhatsApp.
- `ZG_HEARTBEAT_NTFY_TOPIC` — opcional: ativa os avisos no celular (veja a seção "Sinal no celular").
- `PORT` — opcional, padrão `3900`.
- `ZG_MAX_ATRASO_MINUTOS` — opcional, padrão `60`: se o servidor/WhatsApp ficar fora do ar e uma mensagem agendada atrasar mais do que isso, ela **não** é disparada ao religar — vira "Expirada" na fila (com botão de reenviar). Mensagens recorrentes pulam para a próxima ocorrência.

### 3. Volumes (aba Mounts) — OBRIGATÓRIO

Sem estes volumes, cada redeploy apaga a sessão do WhatsApp (novo QR), a fila e as mídias. Crie 3 **Volume Mounts**:

| Nome (sugestão)    | Mount Path           | Guarda o quê                        |
|--------------------|----------------------|-------------------------------------|
| `zapgrupos-auth`   | `/app/.wwebjs_auth`  | Sessão do WhatsApp (o QR escaneado) |
| `zapgrupos-data`   | `/app/data`          | Fila, campanhas e histórico         |
| `zapgrupos-media`  | `/app/media`         | Fotos, vídeos e áudios anexados     |

### 4. Domínio e porta

Em **Domains**, adicione seu domínio (ou use o gerado pelo EasyPanel) apontando para a porta **3900** do container, com HTTPS ativado.

### 5. Primeiro acesso

1. Faça o **Deploy** e aguarde o build terminar (o build instala o Google Chrome, demora alguns minutos).
2. Abra a URL do app, entre com a senha.
3. Vá na aba **Conexão** e escaneie o QR code com o WhatsApp do celular
   (WhatsApp → Aparelhos conectados → Conectar um aparelho).

A sessão fica salva no volume — redeploys **não** pedem QR de novo.

> **Atualizações**: com o auto-deploy do EasyPanel ligado (webhook do GitHub), cada push no `main` gera build e deploy automáticos.

---

## Como usar

1. Aba **Nova mensagem**: escolha o tipo (texto, foto/vídeo, áudio, enquete).
2. Marque os **grupos** que vão receber.
3. Ajuste **Simulação e menção** (envio simulado vem ligado; menção a todos é opcional).
4. Em **Quando enviar**, escolha data/hora **ou** ligue "Enviar agora".
5. Clique em **Agendar mensagem**.
6. Acompanhe tudo na aba **Fila** — lá você pode enviar na hora, reenviar, cancelar ou excluir.

Para sequências de vários dias, use a aba **Campanhas**: monte as etapas uma vez e lance quantas vezes quiser, escolhendo grupos e data de início a cada lançamento.

---

## Sinal no celular (opcional)

O ZapGrupos pode mandar notificações para o seu celular via [ntfy.sh](https://ntfy.sh): um "estou vivo" periódico e um alerta quando o WhatsApp cair ou reconectar.

1. Instale o app **ntfy** no celular (iPhone ou Android).
2. Invente um nome de tópico **secreto e difícil de adivinhar** (ex: `zapgrupos-a8f3k29x7q`). Qualquer pessoa que souber o nome recebe e pode enviar notificações nele — trate como uma senha.
3. No app ntfy, assine (subscribe) esse tópico.
4. No EasyPanel, defina a variável `ZG_HEARTBEAT_NTFY_TOPIC` com esse tópico e faça redeploy.

Sem a variável, o recurso fica desativado — o resto do sistema funciona normalmente.

---

## Onde ficam as coisas (dentro do container)

- `/app/data/db.json` — fila de mensagens, campanhas e histórico.
- `/app/media/` — arquivos de foto/vídeo/áudio anexados.
- `/app/.wwebjs_auth/` — sessão do WhatsApp (não compartilhe esta pasta).

Os três são volumes do EasyPanel e sobrevivem a redeploys.

---

## Avisos importantes

- Use com bom senso. Disparos em massa e frequentes podem fazer o WhatsApp **bloquear seu número**. O "envio simulado" e as pausas entre grupos reduzem esse risco, mas não eliminam.
- Ferramenta para **uso pessoal** com seus próprios grupos e contatos que esperam receber suas mensagens. Respeite as regras do WhatsApp e não use para spam.
- "Mencionar todos" exige que você tenha os participantes visíveis no grupo (normalmente sendo admin).
- Se o WhatsApp Web mudar e a conexão parar de funcionar, geralmente a correção é atualizar a dependência `whatsapp-web.js` (atualizar o `package-lock.json` e fazer redeploy).
