FROM node:20-slim

# Install Lightweight Chromium & dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    python3 \
    ffmpeg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Environment Variables for Puppeteer Core
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8000

CMD ["npm", "start"]
