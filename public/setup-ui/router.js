import { useEffect, useState } from "./vendor/preact-hooks.module.js";

const readHash = () => {
  const raw = window.location.hash.replace(/^#/, "");
  return raw.length === 0 ? "/" : raw;
};

export const useHashRoute = () => {
  const [route, setRoute] = useState(readHash());
  useEffect(() => {
    const onChange = () => setRoute(readHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
};

export const navigate = (path) => {
  if (window.location.hash.replace(/^#/, "") !== path) {
    window.location.hash = path;
  }
};
