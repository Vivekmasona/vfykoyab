FROM node:20-slim

# Install Python, FFmpeg & create 'python' alias symlink
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python-is-python3 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8000

CMD ["node", "index.js"]
