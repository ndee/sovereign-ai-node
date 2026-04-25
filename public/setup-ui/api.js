export class ApiError extends Error {
  constructor(detail, statusCode) {
    super(detail?.message ?? "API error");
    this.name = "ApiError";
    this.detail = detail;
    this.statusCode = statusCode;
  }
}

const parseEnvelope = async (response) => {
  let body = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      { code: "INVALID_RESPONSE", message: `Non-JSON response (HTTP ${response.status})` },
      response.status,
    );
  }
  if (body && body.ok === true) {
    return body.result;
  }
  throw new ApiError(body?.error ?? { code: "UNKNOWN_ERROR", message: "Unknown error" }, response.status);
};

export const apiGet = async (path) => {
  const response = await fetch(path, { method: "GET", headers: { Accept: "application/json" } });
  return parseEnvelope(response);
};

export const apiPost = async (path, body) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return parseEnvelope(response);
};
