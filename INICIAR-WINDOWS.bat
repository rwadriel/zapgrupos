@echo off
title ZapGrupos
echo Iniciando ZapGrupos...
if not exist node_modules (
  echo Instalando dependencias pela primeira vez, aguarde...
  call npm install
)
start "" http://localhost:3900
call npm start
pause
