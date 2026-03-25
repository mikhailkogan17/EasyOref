# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# EasyOref Dockerfile — RPi build
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --legacy-peer-deps
COPY packages packages
RUN npm install --ignore-scripts --legacy-peer-deps
RUN npm run build

# Stage 2: Production
FROM node:22-alpine AS production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts --legacy-peer-deps
COPY packages packages
RUN npm install --omit=dev --ignore-scripts --legacy-peer-deps
COPY --from=builder /app .
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3100
CMD ["node", "packages/bot/dist/bot.js"]
