FROM node:20-slim

# Install FFmpeg and Python
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps for audio alignment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install numpy scipy

WORKDIR /app

# Install Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY server/ ./server/
COPY src/ ./src/
COPY index.html vite.config.js vercel.json ./

# Create required directories
RUN mkdir -p uploads/videos uploads/thumbnails uploads/frames uploads/temp data

EXPOSE ${PORT:-3001}

CMD ["node", "server/index.js"]
