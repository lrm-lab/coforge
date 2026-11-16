# Local / fixture image for one cloud Computer (not staging or production Swarm).
# Swarm images are built from infra/cloud-computer-image/.
# Build context is a directory that already contains the coforge-computer binary.
FROM debian:bookworm-slim
ARG COMPUTER_VERSION=
LABEL org.coforge.computer.version=${COMPUTER_VERSION}
COPY coforge-computer /usr/local/bin/coforge-computer
RUN chmod 755 /usr/local/bin/coforge-computer && mkdir -p /workspace
WORKDIR /workspace
ENTRYPOINT ["coforge-computer", "foreground"]
