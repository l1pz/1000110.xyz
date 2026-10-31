#!/bin/sh
# Run on the server in /opt/stacks/uptime-kuma/. Asks for the secrets, never stores them.
set -e
cd "$(dirname "$0")"
printf 'Kuma admin user: '; read -r KUMA_USER
printf 'Kuma admin password: '; stty -echo; read -r KUMA_PASS; stty echo; echo
printf 'SMTP host (empty = skip email): '; read -r KUMA_SMTP_HOST
if [ -n "$KUMA_SMTP_HOST" ]; then
  printf 'SMTP port [587]: '; read -r KUMA_SMTP_PORT
  printf 'SMTP user: '; read -r KUMA_SMTP_USER
  printf 'SMTP password: '; stty -echo; read -r KUMA_SMTP_PASS; stty echo; echo
  printf 'From address: '; read -r KUMA_SMTP_FROM
  printf 'Alert address: '; read -r KUMA_SMTP_TO
fi
export KUMA_USER KUMA_PASS KUMA_SMTP_HOST KUMA_SMTP_PORT KUMA_SMTP_USER KUMA_SMTP_PASS KUMA_SMTP_FROM KUMA_SMTP_TO
docker run --rm --network proxy -v "$PWD:/k:ro" \
  -e KUMA_USER -e KUMA_PASS -e KUMA_SMTP_HOST -e KUMA_SMTP_PORT -e KUMA_SMTP_USER \
  -e KUMA_SMTP_PASS -e KUMA_SMTP_FROM -e KUMA_SMTP_TO python:3.13-slim \
  sh -c 'pip install -q --root-user-action=ignore uptime-kuma-api-v2==1.0.3 && python /k/provision.py'
