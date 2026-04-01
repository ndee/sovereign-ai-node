export type SovereignPaths = {
  configPath: string;
  secretsDir: string;
  stateDir: string;
  logsDir: string;
  installJobsDir: string;
  openclawServiceHome: string;
  provenancePath: string;
  backupsDir: string;
};

export const DEFAULT_PATHS: SovereignPaths = {
  configPath: "/etc/sovereign-node/sovereign-node.json5",
  secretsDir: "/etc/sovereign-node/secrets",
  stateDir: "/var/lib/sovereign-node",
  logsDir: "/var/log/sovereign-node",
  installJobsDir: "/var/lib/sovereign-node/install-jobs",
  openclawServiceHome: "/var/lib/sovereign-node/openclaw-home",
  provenancePath: "/etc/sovereign-node/install-provenance.json",
  backupsDir: "/var/lib/sovereign-node/backups",
};
