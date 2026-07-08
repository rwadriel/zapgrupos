# ZapGrupos

Agendador local de mensagens para **grupos** do WhatsApp. Roda 100% na sua máquina — nada é enviado para servidor externo. Foi feito só para grupos, com foco em: agendamento, envio imediato manual, texto, foto/vídeo, áudio como nota de voz (gravado "na hora"), enquetes e menção a todos.

---

## O que ele faz

- **Agenda** mensagens para uma data/hora, ou **dispara agora**.
- Envia para **vários grupos de uma vez**, um por vez, com pausa aleatória entre eles.
- Tipos de conteúdo:
  - **Texto**
  - **Foto / vídeo** (com legenda opcional)
  - **Áudio** enviado como **nota de voz (PTT)** — aparece como se você tivesse gravado na hora, com o status "gravando áudio…" antes.
  - **Enquete** (2 a 12 opções, resposta única ou múltipla).
- **Simular envio manual**: mostra "digitando…" / "gravando…" e espera um tempo natural, proporcional ao tamanho do conteúdo, antes de enviar.
- **Mencionar todos**: notifica o grupo inteiro sem poluir o texto com dezenas de @.
- **Repetição**: diária ou semanal, no mesmo horário.
- **Fila** com status de cada envio (agendada, enviando, enviada, parcial, falhou) e relatório por grupo.

---

## Como instalar

Você precisa do **Node.js 18 ou superior** instalado (https://nodejs.org).

1. Abra o terminal dentro da pasta `zapgrupos`.
2. Instale as dependências (só na primeira vez):

   ```
   npm install
   ```

   > Na primeira instalação ele baixa um navegador (Chromium) usado internamente para conectar ao WhatsApp Web. Pode demorar alguns minutos.

3. Inicie o sistema:

   ```
   npm start
   ```

4. Abra no navegador: **http://localhost:3900**

5. Vá na aba **Conexão** e escaneie o QR code com o WhatsApp do celular
   (WhatsApp → Aparelhos conectados → Conectar um aparelho).

A sessão fica salva — nas próximas vezes você não precisa escanear de novo.

---

## Como usar

1. Aba **Nova mensagem**: escolha o tipo (texto, foto/vídeo, áudio, enquete).
2. Marque os **grupos** que vão receber.
3. Ajuste **Simulação e menção** (envio simulado vem ligado; menção a todos é opcional).
4. Em **Quando enviar**, escolha data/hora **ou** ligue "Enviar agora".
5. Clique em **Agendar mensagem**.
6. Acompanhe tudo na aba **Fila** — lá você pode enviar na hora, reenviar, cancelar ou excluir.

---

## Onde ficam as coisas

- `data/jobs.json` — sua fila de mensagens agendadas.
- `media/` — arquivos de foto/vídeo/áudio que você anexou.
- `.wwebjs_auth/` — sua sessão do WhatsApp (não compartilhe esta pasta).

Para trocar a porta: `PORT=4000 npm start`.

---

## Avisos importantes

- Use com bom senso. Disparos em massa e frequentes podem fazer o WhatsApp **bloquear seu número**. O "envio simulado" e as pausas entre grupos reduzem esse risco, mas não eliminam.
- Ferramenta para **uso pessoal** com seus próprios grupos e contatos que esperam receber suas mensagens. Respeite as regras do WhatsApp e não use para spam.
- "Mencionar todos" exige que você tenha os participantes visíveis no grupo (normalmente sendo admin).
