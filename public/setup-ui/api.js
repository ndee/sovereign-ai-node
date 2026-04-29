export class ApiError extends Error {
  constructor(detail, statusCode) {
    super(detail?.message ?? "API error");
    this.name = "ApiError";
    this.detail = detail;
    this.statusCode = statusCode;
  }
}

let csrfToken = null;

const readCsrfFromCookie = () => {
  const match = document.cookie.match(/(?:^|;\s*)sov_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

export const setCsrf = (token) => {
  csrfToken = token;
};

export const getCsrf = () => csrfToken ?? readCsrfFromCookie();

export const clearAuth = () => {
  csrfToken = null;
};

const handleResponse = async (response) => {
  let body = null;
  try {
    body = await response.json();
  } catch {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent("sov:unauth"));
    }
    throw new ApiError(
      { code: "INVALID_RESPONSE", message: `Non-JSON response (HTTP ${response.status})` },
      response.status,
    );
  }
  if (body && body.ok === true) {
    return body.result;
  }
  if (response.status === 401) {
    clearAuth();
    window.dispatchEvent(new CustomEvent("sov:unauth"));
  }
  throw new ApiError(
    body?.error ?? { code: "UNKNOWN_ERROR", message: "Unknown error" },
    response.status,
  );
};

export const apiGet = async (path) => {
  const response = await fetch(path, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  return handleResponse(response);
};

export const apiPost = async (path, body) => {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const csrf = getCsrf();
  if (csrf) {
    headers["X-CSRF-Token"] = csrf;
  }
  const response = await fetch(path, {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify(body ?? {}),
  });
  return handleResponse(response);
};
