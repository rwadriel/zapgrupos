FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
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
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p
git commit -m "Adicionar Dockerfile"
git push https://rwadriel:SEU_TOKEN@github.com/rwadriel/zapgrupos.git mainghp_ODSpi0c8H


cd ~/Desktop/Sistemas/zapgrupos

cat > Dockerfile << 'EOF'

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \

    chromium \

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

    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p data media .wwebjs_auth

EXPOSE 3900

CMD ["node", "server.js"]

