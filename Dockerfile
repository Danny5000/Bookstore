# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:26.7.0-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

FROM dependencies AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev
RUN node -e "import('sharp').then(async ({default: sharp}) => sharp({create:{width:1,height:1,channels:4,background:'#fff'}}).webp().toBuffer())"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p \
      /var/lib/pale-orbit/staging \
      /var/lib/pale-orbit/publication \
      /var/lib/pale-orbit/covers \
    && chown node:node \
      /var/lib/pale-orbit/staging \
      /var/lib/pale-orbit/publication \
      /var/lib/pale-orbit/covers
USER node
EXPOSE 3000
CMD ["node", "build"]

FROM runtime AS production
