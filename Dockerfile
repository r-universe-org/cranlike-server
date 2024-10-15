FROM node:22-alpine

RUN apk add --no-cache bash tini

EXPOSE 3000

RUN mkdir /app && cd /app && npm install cranlike@0.22.15

WORKDIR /app/node_modules/cranlike

ENTRYPOINT [ "tini", "--", "/app/node_modules/cranlike/docker-entrypoint.sh"]
CMD ["cranlike"]
