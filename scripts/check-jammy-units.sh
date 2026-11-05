#!/bin/sh
# Native parser only; never starts units or reads the runner's unrelated sites.
set -eu
test "${CI:-}" = true
test "${GITHUB_ACTIONS:-}" = true
case "$(systemd --version)" in 'systemd 249 '*) ;; *) exit 1;; esac
task_probe="$PWD/.runtime/jammy-unit-probe"
task_base="$task_probe/vendor-core"
test ! -e "$task_probe"
mkdir -p "$task_base" "$task_probe/negative"
cp .runtime/jammy-bundle/*.service .runtime/jammy-bundle/*.timer .runtime/jammy-bundle/*.slice "$task_probe/"
# Approved /opt executables are not installed on CI. Attuner directives stay
# unchanged except ExecStart; the private copy uses the documented install mode.
sed -i 's|^ExecStart=.*|ExecStart=/bin/true|' "$task_probe/"*.service
chmod 0644 "$task_probe/"*.service "$task_probe/"*.timer "$task_probe/"*.slice
# Copy distro core dependency definitions, not host .wants links, /run units,
# administrator overrides or unrelated application services. No fake target or
# journal service is substituted. Complete host boot activation is a later gate.
cp -L /lib/systemd/system/*.target "$task_base/"
cp /lib/systemd/system/systemd-journald@.service /lib/systemd/system/systemd-journald@.socket /lib/systemd/system/systemd-journald-varlink@.socket "$task_base/"
export SYSTEMD_UNIT_PATH="$task_probe:$task_base"
if ! systemd-analyze verify "$task_probe/"*.service "$task_probe/"*.timer "$task_probe/"*.slice 2> .runtime/jammy-unit-verification.log; then
  cat .runtime/jammy-unit-verification.log
  exit 1
fi
if test -s .runtime/jammy-unit-verification.log; then
  cat .runtime/jammy-unit-verification.log
  exit 1
fi
cp "$task_probe/attuner-staging-api.service" "$task_probe/negative/attuner-staging-api.service"
printf '\n[Service]\nAttunerInvalidSetting=yes\n' >> "$task_probe/negative/attuner-staging-api.service"
systemd-analyze verify "$task_probe/negative/attuner-staging-api.service" 2> .runtime/jammy-unit-negative-control.log || :
if ! rg -q "Unknown key name 'AttunerInvalidSetting'" .runtime/jammy-unit-negative-control.log; then
  cat .runtime/jammy-unit-negative-control.log
  exit 1
fi
printf '%s\n' 'Actual systemd 249 syntax passed with zero diagnostics; invalid Attuner directive control detected. No unit activation or runner configuration changes.'
