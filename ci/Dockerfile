# yaah's CI, locally: an image close to GitHub's `ubuntu-latest` (Ubuntu 24.04)
# with the Tauri Linux build dependencies and the toolchain from app/mise.toml.
#
#   mise run ci:docker                    # from app/: build the image, run `mise run ci` in it
#   CI_TASK=ci:rust mise run ci:docker    # one task
#
# The repository is mounted read-only at /src and copied into a volume
# (/home/runner/work) on each run, so the host's macOS target/ and node_modules/
# are never touched and Linux builds stay warm between runs. Cargo's registry,
# the pnpm store and the conformance installs are volumes too.
#
# No Docker-in-Docker: tests/data_docker.rs and tests/data_postgres.rs skip with
# "skipped: …" when there's no daemon or Postgres to reach, which is the case in here.

# Only the [tools] part of app/mise.toml goes into the image, so editing a task
# doesn't reinstall the toolchain (the layer below is cached on this file's content).
FROM ubuntu:24.04 AS toolchain
COPY app/mise.toml /mise.toml
RUN awk '/^\[tasks/ { exit } { print }' /mise.toml > /tools.toml

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Tauri 2's Linux prerequisites (tauri.app/start/prerequisites), plus what CI itself uses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config file curl wget git ca-certificates rsync unzip xz-utils procps \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
 && rm -rf /var/lib/apt/lists/*

# Not root, like the runner: some tests check file modes, which root ignores.
RUN useradd --create-home --shell /bin/bash --uid 1001 runner
USER runner
WORKDIR /home/runner
ENV HOME=/home/runner \
    PATH=/home/runner/.local/bin:/home/runner/.local/share/mise/shims:/home/runner/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    MISE_YES=1 \
    MISE_TRUSTED_CONFIG_PATHS=/home/runner/work:/home/runner/toolchain \
    npm_config_store_dir=/home/runner/.pnpm-store \
    YAAH_CONFORMANCE_ROOT=/home/runner/conformance \
    CARGO_TERM_COLOR=never \
    CI=true

# mise, pinned; then the toolchain, in its own layer so a source change doesn't reinstall it.
ARG MISE_VERSION=v2026.10.21
RUN curl -fsSL https://mise.run | MISE_VERSION=${MISE_VERSION} MISE_INSTALL_PATH=/home/runner/.local/bin/mise sh
COPY --from=toolchain --chown=runner:runner /tools.toml /home/runner/toolchain/mise.toml
RUN cd /home/runner/toolchain && mise install && mise ls --current

# Mount points owned by the runner, so fresh named volumes are too.
RUN mkdir -p /home/runner/work /home/runner/.cargo/registry /home/runner/.pnpm-store /home/runner/conformance

# Each task says how long it took.
ENV MISE_TASK_TIMINGS=1

CMD ["bash", "-c", "set -e; rsync -a --delete --exclude .git/ --exclude node_modules/ --exclude target/ --exclude dist/ --exclude coverage/ --exclude /dist-release/ /src/ /home/runner/work/; cd /home/runner/work/app; mise run ${CI_TASK:-ci}"]
