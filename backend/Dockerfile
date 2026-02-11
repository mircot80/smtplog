FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

RUN mkdir -p /app/data /app/logs

EXPOSE 3000

CMD ["node", "index.js"]
