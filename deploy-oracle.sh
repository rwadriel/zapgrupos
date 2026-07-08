#!/bin/bash
# deploy-oracle.sh — Setup completo do ZapGrupos numa instância Oracle Cloud Free Tier
# Rode com: bash deploy-oracle.sh
set -e

echo "=========================================="
echo "  ZapGrupos — Deploy Oracle Cloud"
echo "=========================================="
echo ""

# 1. Atualizar sistema
echo "[1/6] Atualizando o sistema..."
sudo apt update && sudo apt upgrade -y

# 2. Instalar Node.js 20 LTS
echo "[2/6] Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Instalar Chromium (necessário pro whatsapp-web.js)
echo "[3/6] Instalando Chromium..."
sudo apt install -y chromium-browser || sudo apt install -y chromium
# Descobre o caminho do Chromium instalado
CHROME_PATH=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null || echo "/usr/bin/chromium-browser")
echo "   Chromium em: $CHROME_PATH"

# 4. Criar pasta e baixar o projeto (ou usar o zip já enviado)
echo "[4/6] Preparando o projeto..."
cd ~
if [ ! -d zapgrupos ]; then
  echo "   Pasta ~/zapgrupos não encontrada."
  echo "   Envie o zapgrupos.zip via scp e descompacte:"
  echo "     scp zapgrupos.zip ubuntu@SEU_IP:~/"
  echo "     unzip zapgrupos.zip"
  echo "   Depois rode este script de novo."
  exit 1
fi
cd ~/zapgrupos

# 5. Instalar dependências
echo "[5/6] Instalando dependências do Node..."
PUPPETEER_EXECUTABLE_PATH="$CHROME_PATH" npm install

# 6. Configurar variáveis de ambiente e systemd
echo "[6/6] Criando serviço systemd..."

# Gera uma senha aleatória se não existir .env
if [ ! -f .env ]; then
  SENHA=$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)
  cat > .env << EOF
ZAPGRUPOS_SENHA=$SENHA
PUPPETEER_EXECUTABLE_PATH=$CHROME_PATH
PORT=3900
EOF
  echo ""
  echo "  ╔════════════════════════════════════════════════╗"
  echo "  ║  SENHA GERADA: $SENHA               ║"
  echo "  ║  Salve em lugar seguro! Está em ~/zapgrupos/.env  ║"
  echo "  ╚════════════════════════════════════════════════╝"
  echo ""
fi

# Carrega variáveis do .env
source .env

sudo tee /etc/systemd/system/zapgrupos.service > /dev/null << UNIT
[Unit]
Description=ZapGrupos — agendador de grupos WhatsApp
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/zapgrupos
EnvironmentFile=$HOME/zapgrupos/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable zapgrupos
sudo systemctl start zapgrupos

# Abrir porta 3900 no firewall do Ubuntu (iptables)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3900 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null

echo ""
echo "=========================================="
echo "  ✅ ZapGrupos está rodando!"
echo ""
echo "  Acesse: http://$(curl -s ifconfig.me):3900"
echo "  Senha:  $(grep ZAPGRUPOS_SENHA .env | cut -d= -f2)"
echo ""
echo "  Comandos úteis:"
echo "    sudo systemctl status zapgrupos    # ver status"
echo "    sudo journalctl -u zapgrupos -f    # ver logs"
echo "    sudo systemctl restart zapgrupos   # reiniciar"
echo "=========================================="
