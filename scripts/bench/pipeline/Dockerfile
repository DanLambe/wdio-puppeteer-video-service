FROM node:24.18.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation fonts-noto-color-emoji libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json .npmrc ./
COPY scripts/check-install-scripts.ts scripts/check-install-scripts.ts
RUN corepack npm ci --ignore-scripts \
 && corepack npm run check:install-scripts \
 && corepack npm rebuild esbuild ffmpeg-static
RUN node node_modules/@puppeteer/browsers/lib/cjs/main-cli.js install chrome@154.0.8037.57 --path /browsers \
 && node node_modules/@puppeteer/browsers/lib/cjs/main-cli.js install chromedriver@154.0.8037.57 --path /browsers
ENV CHROME_BINARY=/browsers/chrome/linux-154.0.8037.57/chrome-linux64/chrome \
    CHROMEDRIVER_BINARY=/browsers/chromedriver/linux-154.0.8037.57/chromedriver-linux64/chromedriver \
    FFMPEG_PATH=/work/node_modules/ffmpeg-static/ffmpeg
