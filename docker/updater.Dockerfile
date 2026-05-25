# taskhub-updater (v1.22): privileged sidecar that runs the upgrade command.
# Holds the host docker socket — never expose this container outside the
# compose network. Opt-in via `docker compose --profile upgrade up`.

FROM node:20-alpine

# Tools the upgrade command needs:
#   - git           — to pull new code
#   - docker-cli +  — to run `docker compose up -d --build`
#     docker-cli-compose
RUN apk add --no-cache git docker-cli docker-cli-compose

WORKDIR /app
COPY server.js .

EXPOSE 9000
CMD ["node", "server.js"]
