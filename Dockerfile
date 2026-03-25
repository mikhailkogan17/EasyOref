# EasyOref Dockerfile — RPi build
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages packages
COPY tsconfig*.json ./
RUN npm install --legacy-peer-deps --ignore-scripts
RUN npm run build
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3100
CMD ["node", "packages/bot/dist/bot.js"]
