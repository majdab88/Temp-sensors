FROM node:20-alpine

WORKDIR /app

# Install dependencies first (separate layer for Docker cache efficiency).
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source (Phase 2 will replace src/ with the full implementation).
COPY src/ ./src/

EXPOSE 3000
CMD ["node", "src/index.js"]
