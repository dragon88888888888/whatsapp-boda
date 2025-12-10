FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install dependencies into temp directory
FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lockb* /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Copy source code
FROM base AS prerelease
COPY --from=install /temp/prod/node_modules node_modules
COPY . .

# Copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/chatwhats.js .
COPY --from=prerelease /usr/src/app/rag-chat.js .
COPY --from=prerelease /usr/src/app/mcp.json .
COPY --from=prerelease /usr/src/app/package.json .

# Set environment
ENV NODE_ENV=production
ENV PORT=5000

# Run as bun user
USER bun
EXPOSE 5000/tcp
ENTRYPOINT [ "bun", "run", "chatwhats.js" ]
