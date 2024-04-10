FROM node:lts AS BUILD_IMAGE

WORKDIR /app

COPY . /app

RUN npm i --registry http://registry.npmmirror.com && npm run build

FROM node:lts-alpine

COPY --from=BUILD_IMAGE /app/public /app/public
COPY --from=BUILD_IMAGE /app/configs /app/configs
COPY --from=BUILD_IMAGE /app/package.json /app/package.json
COPY --from=BUILD_IMAGE /app/dist /app/dist
COPY --from=BUILD_IMAGE /app/node_modules /app/node_modules

WORKDIR /app

EXPOSE 8000

CMD ["npm", "start"]