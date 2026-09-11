FROM node:24.13.1-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /data && chown node:node /data
USER node
ENV CODEVO_HOST=0.0.0.0 CODEVO_PORT=4318 CODEVO_DATA_DIR=/data
EXPOSE 4318
CMD ["node", "src/main.ts"]
