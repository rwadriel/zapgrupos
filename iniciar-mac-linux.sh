#!/bin/bash
cd "$(dirname "$0")"
echo "Iniciando ZapGrupos..."
if [ ! -d node_modules ]; then
  echo "Instalando dependencias pela primeira vez, aguarde..."
  npm install
fi
( sleep 3 && (open http://localhost:3900 2>/dev/null || xdg-open http://localhost:3900 2>/dev/null) ) &
npm start
