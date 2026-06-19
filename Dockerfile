FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium

COPY dist/ ./dist/

ENTRYPOINT ["node", "dist/index.js"]
