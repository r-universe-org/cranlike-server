FROM node:12-alpine

RUN apk add --no-cache bash tini

EXPOSE 3000

# Copied from mongodb-express image
ENV CRANLIKE_MONGODB_SERVER="mongo" \
    VCAP_APP_HOST="0.0.0.0"

RUN npm install cranlike@0.3.1

COPY docker-entrypoint.sh /

WORKDIR /node_modules/cranlike

ENTRYPOINT [ "tini", "--", "/docker-entrypoint.sh"]
CMD ["cranlike"]
