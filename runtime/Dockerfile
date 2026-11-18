FROM cubejs/cube:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Configure default git user for commits from UI
RUN git config --global user.name "Cube Web-UI" \
    && git config --global user.email "cube-ui@cube.dev" \
    && git config --global init.defaultBranch master \
    && git config --global --add safe.directory "*"

USER node
