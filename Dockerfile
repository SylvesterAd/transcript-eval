FROM node:20-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies (production only)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy server source only (frontend is on Vercel)
COPY server/ ./server/

# Create required directories
RUN mkdir -p uploads/videos uploads/thumbnails uploads/frames uploads/temp data

EXPOSE 3001

CMD ["node", "server/index.js"]
