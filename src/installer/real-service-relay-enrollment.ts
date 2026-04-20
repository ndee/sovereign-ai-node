import type { InstallRequest } from "../contracts/index.js";

import {
  isRecord,
  parseJsonDocument,
  type RelayTunnelConfig,
  summarizeText,
} from "./real-service-shared.js";

export type RelayEnrollmentData = {
  controlUrl: string;
  hostname: string;
  publicBaseUrl: string;
  tunnel: RelayTunnelConfig;
};

export const tryUsePreEnrolledRelay = (input: {
  relay: NonNullable<InstallRequest["relay"]>;
  localEdgePort: number;
}): RelayEnrollmentData | null => {
  if (!input.relay.hostname || !input.relay.publicBaseUrl || !input.relay.tunnel) {
    return null;
  }
  const tunnel = input.relay.tunnel;
  if (!tunnel.serverAddr || !tunnel.token || !tunnel.proxyName) {
    return null;
  }
  return {
    controlUrl: input.relay.controlUrl,
    hostname: input.relay.hostname,
    publicBaseUrl: input.relay.publicBaseUrl,
    tunnel: {
      serverAddr: tunnel.serverAddr,
      serverPort: tunnel.serverPort ?? 7000,
      token: tunnel.token,
      proxyName: tunnel.proxyName,
      ...(tunnel.subdomain === undefined ? {} : { subdomain: tunnel.subdomain }),
      type: "http",
      localIp: "127.0.0.1",
      localPort: input.localEdgePort,
    },
  };
};

export const parseManagedRelayEnrollmentResponse = (input: {
  responseText: string;
  controlUrl: string;
  requestedSlug: string;
  localEdgePort: number;
}): RelayEnrollmentData => {
  const parsed = parseJsonDocument(input.responseText);
  const payload =
    isRecord(parsed) && isRecord(parsed.result) ? parsed.result : isRecord(parsed) ? parsed : null;
  const tunnel = payload !== null && isRecord(payload.tunnel) ? payload.tunnel : null;
  const hostname =
    payload !== null && typeof payload.assignedHostname === "string"
      ? payload.assignedHostname.trim()
      : payload !== null && typeof payload.hostname === "string"
        ? payload.hostname.trim()
        : "";
  const publicBaseUrl =
    payload !== null && typeof payload.publicBaseUrl === "string"
      ? payload.publicBaseUrl.trim()
      : "";
  const serverAddr =
    tunnel !== null && typeof tunnel.serverAddr === "string"
      ? tunnel.serverAddr.trim()
      : tunnel !== null && typeof tunnel.serverHost === "string"
        ? tunnel.serverHost.trim()
        : "";
  const serverPort =
    tunnel !== null && typeof tunnel.serverPort === "number" && Number.isFinite(tunnel.serverPort)
      ? Math.trunc(tunnel.serverPort)
      : 7000;
  const token =
    tunnel !== null && typeof tunnel.token === "string"
      ? tunnel.token.trim()
      : tunnel !== null && typeof tunnel.authToken === "string"
        ? tunnel.authToken.trim()
        : "";
  const proxyName =
    tunnel !== null && typeof tunnel.proxyName === "string"
      ? tunnel.proxyName.trim()
      : hostname.length > 0
        ? `relay-${hostname.replace(/[^a-zA-Z0-9-]/g, "-")}`
        : "";
  const subdomain =
    tunnel !== null && typeof tunnel.subdomain === "string" && tunnel.subdomain.trim().length > 0
      ? tunnel.subdomain.trim()
      : undefined;

  if (
    hostname.length === 0 ||
    publicBaseUrl.length === 0 ||
    serverAddr.length === 0 ||
    token.length === 0 ||
    proxyName.length === 0
  ) {
    throw {
      code: "RELAY_ENROLL_INVALID",
      message: "Managed relay enrollment returned an incomplete response",
      retryable: false,
      details: {
        controlUrl: input.controlUrl,
        requestedSlug: input.requestedSlug,
        response: summarizeText(input.responseText, 1200),
      },
    };
  }

  return {
    controlUrl: input.controlUrl,
    hostname,
    publicBaseUrl,
    tunnel: {
      serverAddr,
      serverPort,
      token,
      proxyName,
      ...(subdomain === undefined ? {} : { subdomain }),
      type: "http",
      localIp: "127.0.0.1",
      localPort: input.localEdgePort,
    },
  };
};
