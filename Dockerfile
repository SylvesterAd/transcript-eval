FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg python3 pip && rm -rf /var/lib/apt/lists/* \
    && pip install --break-system-packages yt-dlp

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

COPY server/ ./server/

RUN mkdir -p uploads/temp data

EXPOSE 3001

CMD ["node", "server/index.js"]
