import type { RelayRuntimeConfig } from "./real-service-shared.js";

export const renderRelayTunnelConfig = (input: {
  relay: RelayRuntimeConfig;
  token: string;
}): string =>
  [
    `serverAddr = "${input.relay.tunnel.serverAddr}"`,
    `serverPort = ${input.relay.tunnel.serverPort}`,
    "",
    "[auth]",
    'method = "token"',
    `token = "${input.token}"`,
    "",
    "[[proxies]]",
    `name = "${input.relay.tunnel.proxyName}"`,
    `type = "${input.relay.tunnel.type}"`,
    `localIP = "${input.relay.tunnel.localIp}"`,
    `localPort = ${input.relay.tunnel.localPort}`,
    `customDomains = ["${input.relay.hostname}"]`,
    ...(input.relay.tunnel.subdomain === undefined
      ? []
      : [`subdomain = "${input.relay.tunnel.subdomain}"`]),
  ].join("\n");

export const renderRelayTunnelUnit = (input: {
  configPath: string;
  containerName: string;
  image: string;
}): string =>
  [
    "[Unit]",
    "Description=Sovereign Matrix Relay Tunnel",
    "After=network-online.target docker.service",
    "Wants=network-online.target",
    "Requires=docker.service",
    "",
    "[Service]",
    "Type=simple",
    `ExecStartPre=-/usr/bin/docker rm -f ${input.containerName}`,
    `ExecStart=/usr/bin/docker run --rm --name ${input.containerName} --network host -v ${input.configPath}:/etc/frp/frpc.toml:ro ${input.image} -c /etc/frp/frpc.toml`,
    `ExecStop=/usr/bin/docker stop ${input.containerName}`,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
