FROM node:22-slim
WORKDIR /app
COPY container/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY container/server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
