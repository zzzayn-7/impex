#!/bin/bash
# First boot of the Impex server (Amazon Linux 2023): mount the data disk, install Docker and Compose, install the deploy script, run the first deploy.
# Rendered by Terraform; everything long-lived is in files/deploy.sh and in SSM. Log: /var/log/impex-bootstrap.log
set -euo pipefail
exec > >(tee -a /var/log/impex-bootstrap.log) 2>&1

REGION="${region}"
SSM_PREFIX="${ssm_prefix}"
DATA_VOL="${data_vol}"   # the EBS volume id without its dash

dnf install -y docker git jq

# --- the data disk becomes Docker's data directory (images, the PostgreSQL volume, the logos) ----------------------------------------------------------
DEVICE="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$DATA_VOL"
for _ in $(seq 1 60); do [ -e "$DEVICE" ] && break; sleep 2; done
[ -e "$DEVICE" ] || { echo "data disk $DEVICE did not appear"; exit 1; }
if ! blkid "$DEVICE" >/dev/null 2>&1; then mkfs.xfs "$DEVICE"; fi   # only a brand-new, empty disk is formatted: an existing one keeps its data
mkdir -p /var/lib/docker
UUID="$(blkid -s UUID -o value "$DEVICE")"
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /var/lib/docker xfs defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /var/lib/docker || mount /var/lib/docker

# --- swap: the whole stack fits in 2 GB while running, but building the two Next.js apps does not, so a 4 GB swap file is the safety net ---------------------
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi
sysctl -w vm.swappiness=20
echo "vm.swappiness=20" > /etc/sysctl.d/99-impex.conf

# --- Docker + Compose ---------------------------------------------------------------------------------------------------------------------------------------
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

# --- the deploy script, then the first deploy -------------------------------------------------------------------------------------------------------------
mkdir -p /opt/impex-deploy
echo "${deploy_sh}" | base64 -d > /opt/impex-deploy/deploy.sh
chmod 700 /opt/impex-deploy/deploy.sh
printf 'REGION=%s\nSSM_PREFIX=%s\n' "$REGION" "$SSM_PREFIX" > /opt/impex-deploy/settings

/opt/impex-deploy/deploy.sh
