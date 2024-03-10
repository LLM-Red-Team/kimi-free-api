FROM node:lts

WORKDIR /app

COPY . /app

RUN npm i --registry http://registry.npmmirror.com && npm run build

EXPOSE 8000

CMD ["npm", "start"]