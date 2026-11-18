FROM cubejs/cube:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Configure default git user for commits from UI
RUN git config --global user.name "VAS Web-UI" \
    && git config --global user.email "vas-ui@voxelanalytics.dev" \
    && git config --global init.defaultBranch master \
    && git config --global --add safe.directory "*"

RUN mkdir -p /cube/conf/.cubestore && chown -R node:node /cube/conf

USER node
