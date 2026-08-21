FROM node:22-alpine

# git is the storage engine (bare repos); git-daemon ships http-backend
# (the Smart HTTP CGI used by src/git/smartHttp.js).
RUN apk add --no-cache git git-daemon

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Run as uid/gid 1000 to match the `git` user in the nixre-ssh container so
# both can access the shared /data/repos volume.
RUN chown -R 1000:1000 /app \
    && mkdir -p /data/repos && chown -R 1000:1000 /data
USER 1000:1000

ENV NODE_ENV=production
EXPOSE 3002

CMD ["node", "src/server.js"]


