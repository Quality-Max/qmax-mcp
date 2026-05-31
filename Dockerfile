FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

ENV QUALITYMAX_API_KEY=""
ENV QUALITYMAX_API_URL="https://app.qualitymax.io/api/mcp"

ENTRYPOINT ["node", "dist/index.js"]
