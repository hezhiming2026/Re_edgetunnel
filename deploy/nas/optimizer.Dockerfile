FROM node:22-alpine

RUN addgroup -S -g 10001 optimizer \
    && adduser -S -D -H -u 10001 -G optimizer optimizer

WORKDIR /app
COPY optimizer/package.json ./package.json
COPY optimizer/src ./src

USER 10001:10001
ENTRYPOINT ["node", "src/cli.js"]
CMD ["daemon"]
