
FROM node:20-slim



RUN apt-get update && apt-get install -y --no-install-recommends \

    chromium \

    dbus \

    dumb-init \

    ca-certificates \

    fonts-liberation \

    libasound2 \

    libatk-bridge2.0-0 \

    libatk1.0-0 \

    libcairo2 \

    libcups2 \

    libdbus-1-3 \

    libdrm2 \

    libexpat1 \

    libfontconfig1 \

    libgbm1 \

    libglib2.0-0 \

    libgtk-3-0 \

    libnspr4 \

    libnss3 \

    libpango-1.0-0 \

    libpangocairo-1.0-0 \

    libx11-6 \

    libx11-xcb1 \

    libxcb1 \

    libxcomposite1 \

    libxcursor1 \

    libxdamage1 \

    libxext6 \

    libxfixes3 \

    libxi6 \

    libxrandr2 \

    libxrender1 \

    libxss1 \

    libxtst6 \

    xdg-utils \

    && rm -rf /var/lib/apt/lists/*



ENV PUPPETEER_SKIP_DOWNLOAD=true

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

ENV DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket

ENV DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket

ENV XDG_CONFIG_HOME=/tmp/.chromium

ENV XDG_CACHE_HOME=/tmp/.chromium



WORKDIR /app



COPY package*.json ./



RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi



COPY . .



RUN mkdir -p data media .wwebjs_auth /tmp/.chromium /run/dbus



EXPOSE 3900



CMD ["sh", "-c", "echo '[Docker] Iniciando DBus + Node'; mkdir -p /run/dbus; rm -f /run/dbus/pid; dbus-daemon --system --fork --nopidfile || true; exec node server.js"]

