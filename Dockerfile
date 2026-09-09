FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/runtime/sessions /app/runtime/data /app/runtime/logs

ENV NODE_ENV=production
ENV PORT=8000
ENV BOT_DATA_DIR=/app/runtime

EXPOSE 8000

CMD ["npm", "start"]