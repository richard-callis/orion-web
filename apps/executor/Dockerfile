FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist
COPY config ./config

ENV NODE_ENV=production
ENV PORT=3200

EXPOSE 3200

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3200/health || exit 1

CMD ["node", "dist/index.js"]
