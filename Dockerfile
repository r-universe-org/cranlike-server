FROM node:16-alpine

RUN apk add --no-cache bash tini

EXPOSE 3000

# Copied from mongodb-express image
ENV CRANLIKE_MONGODB_SERVER="mongo" \
    VCAP_APP_HOST="0.0.0.0"

RUN mkdir /app && cd /app && npm install cranlike@0.9.64

WORKDIR /app/node_modules/cranlike

ENTRYPOINT [ "tini", "--", "/app/node_modules/cranlike/docker-entrypoint.sh"]
CMD ["cranlike"]
