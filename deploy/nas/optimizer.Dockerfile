FROM node:22-alpine

RUN addgroup -S -g 10001 optimizer \
    && adduser -S -D -H -u 10001 -G optimizer optimizer

WORKDIR /app
COPY --chown=10001:10001 optimizer/package.json ./package.json
COPY --chown=10001:10001 optimizer/src ./src

USER 10001:10001
ENTRYPOINT ["node", "src/cli.js"]
CMD ["daemon"]
