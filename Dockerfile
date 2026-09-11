FROM node:24.13.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:24.13.1-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.13.1-bookworm-slim AS runtime
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production CODEVO_HOST=0.0.0.0 CODEVO_PORT=4318 CODEVO_DATA_DIR=/data
EXPOSE 4318
CMD ["node", "dist/src/main.js"]
