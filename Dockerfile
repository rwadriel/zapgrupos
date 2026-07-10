FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    dumb-init \
    dbus \
    dbus-x11 \
    fonts-liberation \
    xdg-utils \
    tzdata \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-linux-signing-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
ENV XDG_CONFIG_HOME=/tmp/.chrome
ENV XDG_CACHE_HOME=/tmp/.chrome
ENV HOME=/tmp
ENV TZ=America/Sao_Paulo

WORKDIR /app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

RUN mkdir -p data media .wwebjs_auth /tmp/.chrome /run/dbus

EXPOSE 3900

CMD ["sh", "-c", "echo '[Docker] VERSAO DEFINITIVA: Google Chrome Stable + DBus + Crashpad OFF'; mkdir -p /run/dbus /tmp/.chrome; rm -f /run/dbus/pid; dbus-daemon --system --fork --nopidfile || true; exec dumb-init node server.js"]
