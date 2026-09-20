# Build with the generated context prepared by scripts/kind.ts.
FROM docker.io/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
USER root
RUN rm -f /usr/local/bin/bun /usr/local/bin/bunx
COPY --chmod=755 bunc /runtime/bunc
COPY layout /image
ENTRYPOINT ["/runtime/bunc", "run", "/image"]
