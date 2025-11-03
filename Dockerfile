FROM node:20-alpine

WORKDIR /app

# Installer nodemon globalement pour le dev
RUN npm install -g nodemon

COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 80
CMD ["npm", "run", "dev"]