FROM node:22-alpine

# git is the storage engine (bare repos); git-daemon ships http-backend
# (the Smart HTTP CGI used by src/git/smartHttp.js). su-exec drops from
# root to uid 1000 after the entrypoint chowns the bind-mounted volume.
RUN apk add --no-cache git git-daemon su-exec

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY entrypoint.sh /app/entrypoint.sh

# Stay root at image start so the entrypoint can chown a host-mounted
# /data/repos (the image chown is hidden by the bind mount). Then drop
# to 1000:1000 — same uid as the `git` user in nixre-ssh.
RUN chmod 755 /app/entrypoint.sh \
    && chown -R 1000:1000 /app \
    && mkdir -p /data/repos && chown -R 1000:1000 /data

ENV NODE_ENV=production
EXPOSE 3002

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "src/server.js"]


