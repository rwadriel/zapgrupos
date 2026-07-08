FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    dbus \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/dbus

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DBUS_SESSION_BUS_ADDRESS=/dev/null

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p data media .wwebjs_auth

EXPOSE 3900

CMD ["sh", "-c", "dbus-daemon --system --fork 2>/dev/null; exec node server.js"]
