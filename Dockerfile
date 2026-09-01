FROM node:20-slim

# System packages: SSL certificates, Chromium, ffmpeg, python setup
RUN apt-get update && apt-get install -y \
    ca-certificates \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    python3 \
    python-is-python3 \
    ffmpeg \
    curl \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Environment variables for Puppeteer & Node
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /usr/src/app

# Package files copy aur dependency installation
COPY package*.json ./
RUN npm ci --only=production

# Application code copy
COPY . .

# Non-root user permissions (Optional safety for Koyeb/Docker)
EXPOSE 8000

CMD ["npm", "start"]
