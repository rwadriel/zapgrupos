#!/bin/bash
# iniciar.sh — Script de produção para macOS
# Uso: ./iniciar.sh
# Para encerrar: Ctrl+C (o script limpa tudo sozinho ao sair)

cd "$(dirname "$0")"

# ─── Cores ───
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${GREEN}  ┌─────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}  │  ZapGrupos — Iniciando...                   │${NC}"
echo -e "${GREEN}  └─────────────────────────────────────────────┘${NC}"
echo ""

# ─── 1. Mata qualquer instância anterior ───
echo -e "${YELLOW}[1/6]${NC} Limpando processos anteriores..."
# Mata processos na porta 3900
lsof -ti:3900 2>/dev/null | xargs kill -9 2>/dev/null
# Mata Chromium/Chrome órfãos do Puppeteer (só os do zapgrupos)
pgrep -f "userDataDir.*wwebjs" | xargs kill -9 2>/dev/null
sleep 1

# ─── 2. Remove locks de sessão (evita "browser is already running") ───
echo -e "${YELLOW}[2/6]${NC} Removendo locks..."
find .wwebjs_auth -name "SingletonLock" -delete 2>/dev/null
find .wwebjs_auth -name "SingletonCookie" -delete 2>/dev/null
find .wwebjs_auth -name "SingletonSocket" -delete 2>/dev/null

# ─── 3. Detecta o Chrome instalado ───
echo -e "${YELLOW}[3/6]${NC} Detectando navegador..."
if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  echo "   Usando: Google Chrome"
elif [ -f "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" ]; then
  export PUPPETEER_EXECUTABLE_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  echo "   Usando: Brave"
elif [ -f "/Applications/Chromium.app/Contents/MacOS/Chromium" ]; then
  export PUPPETEER_EXECUTABLE_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"
  echo "   Usando: Chromium"
else
  echo "   Usando: Chromium do Puppeteer (padrão)"
fi

# ─── 4. Instala dependências e atualiza whatsapp-web.js ───
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}[4/6]${NC} Instalando dependências (primeira vez)..."
  npm install
else
  # Atualiza whatsapp-web.js automaticamente (1x por dia no máximo)
  UPDATE_FLAG=".last_wwebjs_update"
  HOJE=$(date +%Y-%m-%d)
  ULTIMO=$(cat "$UPDATE_FLAG" 2>/dev/null || echo "nunca")
  if [ "$HOJE" != "$ULTIMO" ]; then
    echo -e "${YELLOW}[4/6]${NC} Verificando atualização do whatsapp-web.js..."
    ANTES=$(npm list whatsapp-web.js --depth=0 2>/dev/null | grep whatsapp-web.js | awk '{print $NF}')
    npm update whatsapp-web.js --save 2>/dev/null
    DEPOIS=$(npm list whatsapp-web.js --depth=0 2>/dev/null | grep whatsapp-web.js | awk '{print $NF}')
    if [ "$ANTES" != "$DEPOIS" ]; then
      echo -e "   ${GREEN}Atualizado: $ANTES → $DEPOIS${NC}"
      # Limpa cache do WhatsApp Web antigo (evita conflitos de versão)
      rm -rf .wwebjs_cache
      echo "   Cache limpo para compatibilidade."
    else
      echo "   Já está na última versão ($DEPOIS)."
    fi
    echo "$HOJE" > "$UPDATE_FLAG"
  else
    echo -e "${YELLOW}[4/6]${NC} Biblioteca já verificada hoje."
  fi
fi

# ─── 5. Limpeza preventiva do cache se estiver corrompido ───
echo -e "${YELLOW}[5/6]${NC} Verificando integridade da sessão..."
# Se a sessão existir mas estiver sem o arquivo principal, limpa pra forçar novo QR
if [ -d ".wwebjs_auth" ] && [ ! -d ".wwebjs_auth/session" ] && [ ! -d ".wwebjs_auth/session-Default" ]; then
  echo "   Sessão corrompida detectada. Limpando para novo QR..."
  rm -rf .wwebjs_auth
else
  echo "   OK."
fi

# ─── Limpeza automática ao encerrar (Ctrl+C) ───
cleanup() {
  echo ""
  echo -e "${YELLOW}Encerrando ZapGrupos...${NC}"
  # Mata Chrome órfão do Puppeteer
  pgrep -f "userDataDir.*wwebjs" | xargs kill -9 2>/dev/null
  # Remove locks pra próxima vez iniciar limpo
  find .wwebjs_auth -name "SingletonLock" -delete 2>/dev/null
  find .wwebjs_auth -name "SingletonCookie" -delete 2>/dev/null
  find .wwebjs_auth -name "SingletonSocket" -delete 2>/dev/null
  echo -e "${GREEN}Encerrado. Até a próxima.${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM

# ─── 6. Inicia ───
echo -e "${YELLOW}[6/6]${NC} Iniciando servidor..."
echo ""
node server.js
