FROM node:22-alpine

# git is the storage engine (bare repos); git-daemon ships http-backend
# (the Smart HTTP CGI used by src/git/smartHttp.js).
RUN apk add --no-cache git git-daemon

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3002

CMD ["node", "src/server.js"]


