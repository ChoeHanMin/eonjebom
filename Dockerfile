FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/eonjebom.db

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

EXPOSE 3000
# Fly.io 볼륨은 root 소유로 붙으므로, 시작할 때 /data 소유자를 node 로 바꾼 뒤 권한을 낮춰서 실행한다.
CMD ["sh", "-c", "mkdir -p /data && chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups node --disable-warning=ExperimentalWarning src/server.js"]
