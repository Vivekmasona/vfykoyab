FROM node:20-slim

# SSL certificates, Chromium for Puppeteer, and system dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    curl \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Environment variables for Puppeteer & Node execution
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /usr/src/app

# Package files copy and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Application code copy
COPY . .

# Expose server port
EXPOSE 8000

CMD ["npm", "start"]
