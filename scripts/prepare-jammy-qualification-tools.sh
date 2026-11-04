#!/bin/sh
# Download/extract distribution binaries into this CI checkout. No apt install,
# service start, host Nginx configuration, package hooks or global apt update.
set -eu
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 22.04
test "${CI:-}" = true
test "${GITHUB_ACTIONS:-}" = true
test "$(id -u)" -ne 0
task_root="$PWD/.runtime/jammy-tools"
test ! -e "$task_root"
mkdir -p "$task_root/lists/partial" "$task_root/cache/archives/partial" "$task_root/packages" "$task_root/root"
apt-get -o Dir::State::lists="$task_root/lists" -o Dir::Cache="$task_root/cache" update > "$task_root/apt-update.log" 2>&1
cd "$task_root/packages"
apt-get -o Dir::State::lists="$task_root/lists" download age nginx-core libpcre3 libgeoip1 > "$task_root/apt-download.log" 2>&1
for package in ./*.deb; do dpkg-deb --extract "$package" "$task_root/root"; done
dpkg-deb --field ./*nginx-core*.deb Version > "$task_root/nginx-version.txt"
dpkg-deb --field ./*age_*.deb Version > "$task_root/age-version.txt"
printf '%s\n' 'Extracted Jammy qualification binaries only; no packages installed or services activated.'
