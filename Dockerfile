FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .
RUN mkdir -p /app/runtime/sessions /app/runtime/data /app/runtime/logs

ENV NODE_ENV=production
ENV PORT=3000
ENV BOT_DATA_DIR=/app/runtime

EXPOSE 3000

CMD ["npm", "start"]