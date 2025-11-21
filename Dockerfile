FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev
COPY server.js ./
COPY sentryWsContext.js ./

ENV NODE_ENV=development

EXPOSE 80
CMD ["node", "server.js"]
