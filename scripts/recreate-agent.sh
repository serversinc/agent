#!/usr/bin/env bash
# Pulls ghcr.io/serversinc/agent:latest on a remote server and recreates the
# running `agent` container with it, preserving its current env, mounts,
# network, and Traefik labels (read from the existing container, not
# hardcoded here, so secrets never live in this script or its output).
#
# Usage: scripts/recreate-agent.sh <ssh-host-alias>
# Example: scripts/recreate-agent.sh Scarloey

set -euo pipefail

HOST="${1:?Usage: recreate-agent.sh <ssh-host-alias>}"

# Runs entirely inside a single remote bash process, building the docker run
# invocation as a bash array (never a string passed through eval) so values
# containing shell metacharacters — e.g. the Traefik rule label's backticks,
# Host(`example.com`) — are never re-parsed as shell syntax.
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail

echo "==> Pulling latest agent image"
sudo docker pull ghcr.io/serversinc/agent:latest

if sudo docker inspect agent >/dev/null 2>&1; then
  echo "==> Capturing current agent container config"
  mapfile -t ENV_LINES < <(sudo docker inspect agent --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -vE '^(PATH|NODE_VERSION|YARN_VERSION)=')
  mapfile -t MOUNT_LINES < <(sudo docker inspect agent --format '{{range .HostConfig.Binds}}{{println .}}{{end}}')
  NETWORK=$(sudo docker inspect agent --format '{{.HostConfig.NetworkMode}}')
  RESTART=$(sudo docker inspect agent --format '{{.HostConfig.RestartPolicy.Name}}')
  mapfile -t LABEL_LINES < <(sudo docker inspect agent --format '{{range $k, $v := .Config.Labels}}{{println $k}}{{println $v}}{{end}}' \
    | grep -v '^org.opencontainers')

  OLD_DIGEST=$(sudo docker inspect agent --format '{{.Image}}')
  echo "==> Current running image: $OLD_DIGEST"

  echo "==> Stopping and removing existing agent container"
  sudo docker stop agent
  sudo docker rm agent
else
  # No container to inspect (first run, or it was removed out-of-band). Fall
  # back to the last known-good config recorded in /etc/agent-container.env
  # on this host (KEY=VALUE lines: PORT, CORE_URL, PUBLIC_KEY_PATH,
  # SECRET_KEY, SERVER_ID, DOMAIN) rather than guessing.
  echo "==> No existing agent container found; bootstrapping from /etc/agent-container.env"
  if [ ! -f /etc/agent-container.env ]; then
    echo "ERROR: no agent container to recreate and /etc/agent-container.env is missing." >&2
    echo "       Create it with PORT, CORE_URL, PUBLIC_KEY_PATH, SECRET_KEY, SERVER_ID, DOMAIN and re-run." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  source <(sudo cat /etc/agent-container.env)
  set +a

  ENV_LINES=(
    "PORT=${PORT}"
    "CORE_URL=${CORE_URL}"
    "PUBLIC_KEY_PATH=${PUBLIC_KEY_PATH}"
    "SECRET_KEY=${SECRET_KEY}"
    "SERVER_ID=${SERVER_ID}"
  )
  MOUNT_LINES=(
    "/var/run/docker.sock:/var/run/docker.sock"
    "/home/ubuntu/agent:/agent"
  )
  NETWORK="traefik"
  RESTART="unless-stopped"
  LABEL_LINES=(
    "traefik.enable" "true"
    "traefik.http.routers.agent.entrypoints" "websecure"
    "traefik.http.routers.agent.rule" "Host(\`${DOMAIN}\`)"
    "traefik.http.routers.agent.tls.certresolver" "le"
    "traefik.http.services.agent.loadbalancer.server.port" "${PORT}"
  )
fi

# The container needs to write to the mounted docker.sock, which is
# group-owned on the host — grant that gid explicitly rather than trusting
# any previous container's config, since a missing --group-add here is a
# silent EACCES in the agent's Docker watcher, not a startup failure.
DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock)

RUN_ARGS=(-d --name agent --restart "$RESTART" --network "$NETWORK" --group-add "$DOCKER_SOCK_GID")

for line in "${MOUNT_LINES[@]}"; do
  [ -n "$line" ] && RUN_ARGS+=(-v "$line")
done

for line in "${ENV_LINES[@]}"; do
  [ -n "$line" ] && RUN_ARGS+=(-e "$line")
done

# LABEL_LINES alternates key, value, key, value, ... (two entries per label).
for ((i = 0; i < ${#LABEL_LINES[@]}; i += 2)); do
  key="${LABEL_LINES[i]}"
  value="${LABEL_LINES[i + 1]:-}"
  [ -n "$key" ] && RUN_ARGS+=(--label "${key}=${value}")
done

echo "==> Starting agent container"
sudo docker run "${RUN_ARGS[@]}" ghcr.io/serversinc/agent:latest

NEW_DIGEST=$(sudo docker inspect agent --format '{{.Image}}')
echo "==> New running image: $NEW_DIGEST"

sleep 2
sudo docker ps --filter name=agent --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
REMOTE
