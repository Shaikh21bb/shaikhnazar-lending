FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node whatsapp.mjs ./
RUN install -d -o node -g node /app/session

USER node
CMD ["node", "whatsapp.mjs"]
