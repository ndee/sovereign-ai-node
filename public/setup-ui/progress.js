import { useEffect, useRef, useState } from "./vendor/preact-hooks.module.js";

export const usePoll = (fetcher, intervalMs, options = {}) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const cancelledRef = useRef(false);
  const isDone = options.isDone ?? (() => false);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled) {
      return undefined;
    }
    let timer = null;

    const tick = async () => {
      try {
        const result = await fetcher();
        if (cancelledRef.current) return;
        setData(result);
        setError(null);
        if (isDone(result)) {
          return;
        }
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err);
      }
      timer = window.setTimeout(tick, intervalMs);
    };

    tick();

    return () => {
      cancelledRef.current = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [fetcher, intervalMs, enabled]);

  return { data, error };
};
