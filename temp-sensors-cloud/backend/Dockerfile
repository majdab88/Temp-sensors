FROM node:20-alpine

WORKDIR /app

# Install dependencies first (separate layer for Docker cache efficiency).
COPY package*.json ./
RUN npm install --omit=dev

# Switch back to `npm ci` once a package-lock.json is committed.
COPY src/ ./src/

EXPOSE 3000
CMD ["node", "src/index.js"]
