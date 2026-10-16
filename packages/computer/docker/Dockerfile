# Local image for one cloud Computer.
# Build context is a directory that already contains the coforge-computer binary.
FROM debian:bookworm-slim
COPY coforge-computer /usr/local/bin/coforge-computer
RUN chmod 755 /usr/local/bin/coforge-computer && mkdir -p /workspace
WORKDIR /workspace
ENTRYPOINT ["coforge-computer", "foreground"]
