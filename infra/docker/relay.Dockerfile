# The relay, for a laptop. Node 22 to match the deployed version.
FROM node:22-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev

COPY server/ .
RUN mkdir -p update

EXPOSE 5000
CMD ["node", "server.js"]
