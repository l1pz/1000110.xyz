#!/usr/bin/env bash
# Installs the stack deploy path on the server (TASKS.md, Phase 3e). Run as root from a checkout of the repo:
#
#   sudo bash deploy/install-stack-deploy.sh --ci-pubkey 'ssh-ed25519 AAAA... ci-stack-deploy' \
#        [--allow uptime-kuma=/opt/stacks/uptime-kuma ...]
#
# Safe to run again: it updates the script, rewrites the CI key and adds allowlist entries; it removes nothing.
# What it creates:
#   user stackdeploy            no docker or sudo group; its only key is the CI key, forced to /usr/local/bin/stack-deploy-ssh
#   /usr/local/bin/stack-deploy-ssh       the forced command: hands "[plan] <stack> <sha>" to the root script
#   /usr/local/libexec/stack-deploy.py    the root script (stacks/stack_deploy.py), run through one sudoers rule
#   /etc/stack-deploy/stacks    the allowlist "name /opt/target" (root-owned: a new stack is an owner step here)
#   /etc/stack-deploy/repo_key  a read-only GitHub deploy key, the only credential this path holds
#   /var/lib/stack-deploy       the checkout it deploys from, a lock and deploy.log
set -euo pipefail

REPO_SSH="git@github.com:l1pz/1000110.xyz.git"
GITHUB_ED25519='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' # published at docs.github.com, "GitHub's SSH key fingerprints"
CONF=/etc/stack-deploy
STATE=/var/lib/stack-deploy
CI_PUBKEY=""
ALLOW=()

while [ $# -gt 0 ]; do
  case "$1" in
    --ci-pubkey) CI_PUBKEY="$2"; shift 2 ;;
    --allow) ALLOW+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
case "$CI_PUBKEY" in ssh-ed25519\ *) ;; *) echo "--ci-pubkey must be an ssh-ed25519 public key" >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."
[ -f stacks/stack_deploy.py ] || { echo "run from a checkout of the repo" >&2; exit 1; }

apt-get install -y git python3-yaml util-linux >/dev/null

id stackdeploy >/dev/null 2>&1 || useradd --create-home --shell /bin/sh --comment "stack deploy (CI, forced command)" stackdeploy

install -d -m 755 -o root -g root "$CONF" /usr/local/libexec
install -d -m 700 -o root -g root "$STATE"
install -m 755 -o root -g root stacks/stack_deploy.py /usr/local/libexec/stack-deploy.py

cat > /usr/local/bin/stack-deploy-ssh <<'WRAP'
#!/bin/sh
# Forced command of the CI key. The request is only ever words for the root script, which checks them again.
set -eu
set -f
exec sudo -n /usr/local/libexec/stack-deploy.py $SSH_ORIGINAL_COMMAND
WRAP
chmod 755 /usr/local/bin/stack-deploy-ssh

echo 'stackdeploy ALL=(root) NOPASSWD: /usr/local/libexec/stack-deploy.py' > /etc/sudoers.d/stack-deploy
chmod 440 /etc/sudoers.d/stack-deploy
visudo -cf /etc/sudoers.d/stack-deploy >/dev/null

install -d -m 700 -o stackdeploy -g stackdeploy /home/stackdeploy/.ssh
echo "restrict,command=\"/usr/local/bin/stack-deploy-ssh\" $CI_PUBKEY" > /home/stackdeploy/.ssh/authorized_keys
chown stackdeploy:stackdeploy /home/stackdeploy/.ssh/authorized_keys
chmod 600 /home/stackdeploy/.ssh/authorized_keys

touch "$CONF/stacks"
chmod 644 "$CONF/stacks"
for entry in "${ALLOW[@]+"${ALLOW[@]}"}"; do
  name="${entry%%=*}"; target="${entry#*=}"
  case "$name" in *[!a-z0-9-]*|"") echo "bad stack name: $name" >&2; exit 1 ;; esac
  case "$target" in /opt/*) ;; *) echo "target must be under /opt: $target" >&2; exit 1 ;; esac
  grep -q "^$name " "$CONF/stacks" || echo "$name $target" >> "$CONF/stacks"
done

# GitHub's host key, checked against the fingerprint GitHub publishes (not trust-on-first-use)
if [ ! -s "$CONF/known_hosts" ]; then
  ssh-keyscan -t ed25519 github.com 2>/dev/null > "$CONF/known_hosts.new"
  seen=$(ssh-keygen -lf "$CONF/known_hosts.new" | awk '{print $2}')
  [ "$seen" = "$GITHUB_ED25519" ] || { rm -f "$CONF/known_hosts.new"; echo "github.com host key $seen does not match the published fingerprint" >&2; exit 1; }
  mv "$CONF/known_hosts.new" "$CONF/known_hosts"
fi

if [ ! -f "$CONF/repo_key" ]; then
  ssh-keygen -q -t ed25519 -N "" -C "stack-deploy read-only deploy key" -f "$CONF/repo_key"
fi
chmod 600 "$CONF/repo_key"

echo
echo "installed. allowed stacks:"; sed 's/^/  /' "$CONF/stacks"
if GIT_SSH_COMMAND="ssh -i $CONF/repo_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$CONF/known_hosts -o StrictHostKeyChecking=yes" git ls-remote "$REPO_SSH" HEAD >/dev/null 2>&1; then
  echo "GitHub read access: ok"
else
  echo
  echo "GitHub read access: NOT YET. Add this as a deploy key (read-only, leave 'Allow write access' OFF) at"
  echo "  https://github.com/l1pz/1000110.xyz/settings/keys"
  cat "$CONF/repo_key.pub"
  echo "then run this script again."
fi
