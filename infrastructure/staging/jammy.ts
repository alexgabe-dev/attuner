/** Deployment profile only. Rendering never runs a host provisioning command. */
export const jammy = {
  os: 'Ubuntu 22.04 LTS',
  architecture: 'x86_64',
  systemdMinimum: 249,
  runtimeSecrets: '/run/attuner-staging-secrets',
};

export function jammyUnit(name: string, source: string): string {
  if (!/^attuner-staging-[a-z-]+(?:@)?\.service$/.test(name))
    throw new Error('Unexpected Attuner service template.');
  if (name === 'attuner-staging-proxy.service')
    throw new Error('Shared Nginx owns HTTPS; never install a second proxy.');
  const role =
    name === 'attuner-staging-api.service' ? 'api' : name.includes('@') ? 'backup' : null;
  let unit = source.replace(
    /^LoadCredentialEncrypted=([a-z.-]+):\/srv\/attuner-staging\/secrets\/\1\.cred$/gm,
    `LoadCredential=$1:${jammy.runtimeSecrets}/$1`,
  );
  if (unit.includes('LoadCredentialEncrypted')) throw new Error('Unconverted credential.');
  unit = unit.replace(
    '[Service]\n',
    '[Service]\nSlice=attuner-staging.slice\nLogNamespace=attuner-staging\n',
  );
  if (role)
    unit = unit.replace(
      '[Unit]\n',
      `[Unit]\nConditionPathExists=${jammy.runtimeSecrets}/${role}.ready\n`,
    );
  return unit;
}

export const slice = `[Unit]
Description=Attuner staging aggregate budget (other applications excluded)

[Slice]
CPUAccounting=yes
CPUQuota=50%
CPUWeight=25
MemoryAccounting=yes
MemoryHigh=2G
MemoryMax=3G
MemorySwapMax=0
TasksMax=512
IOAccounting=yes
IOWeight=25
`;

export const logrotate = `/var/log/attuner-staging/access.log {
  daily
  maxsize 20M
  rotate 7
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su root adm
}
`;

export const journal = `[Journal]
Storage=persistent
SystemMaxUse=128M
RuntimeMaxUse=32M
MaxRetentionSec=7day
RateLimitIntervalSec=30s
RateLimitBurst=500
`;
