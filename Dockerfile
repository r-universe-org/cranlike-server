FROM node:22-alpine

RUN apk add --no-cache bash tini

EXPOSE 3000

COPY . /cranlike

WORKDIR /cranlike

RUN npm --loglevel info install .

ENTRYPOINT [ "tini", "--", "/cranlike/docker-entrypoint.sh"]
