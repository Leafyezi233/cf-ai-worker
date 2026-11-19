import { useCallback, useEffect, useRef, useState } from "react";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const memoryCache = new Map<string, CacheEntry<any>>();
const latestRequests = new Map<string, symbol>();

export function invalidateCache(prefix?: string) {
  if (!prefix) {
    memoryCache.clear();
    latestRequests.clear();
    return;
  }
  for (const key of new Set([...memoryCache.keys(), ...latestRequests.keys()])) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
      latestRequests.delete(key);
    }
  }
}

export function setCacheData<T>(key: string, data: T) {
  latestRequests.delete(key);
  memoryCache.set(key, { data, timestamp: Date.now() });
}

export function getCacheData<T>(key: string): T | undefined {
  return memoryCache.get(key)?.data;
}

export interface UseQueryResult<T> {
  data: T | undefined;
  loading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  updatedAt: number | undefined;
  refresh: (silent?: boolean) => Promise<T | undefined>;
  mutate: (newData: T | ((prev: T | undefined) => T), revalidate?: boolean) => void;
}

export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options?: {
    ttlMs?: number;
    enabled?: boolean;
    revalidateIfFresh?: boolean;
  }
): UseQueryResult<T> {
  const { ttlMs = 60_000, enabled = true, revalidateIfFresh = true } = options || {};
  const cached = key ? memoryCache.get(key) : undefined;
  const active = Boolean(key) && enabled;

  const [data, setData] = useState<T | undefined>(cached?.data);
  const [loading, setLoading] = useState<boolean>(active && !cached);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const [activeKey, setActiveKey] = useState(key);
  if (activeKey !== key) {
    setActiveKey(key);
    setData(cached?.data);
    setLoading(active && !cached);
    setIsRefreshing(false);
    setError(null);
  }

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const keyRef = useRef(key);
  keyRef.current = key;

  const requestSequence = useRef(0);
  useEffect(() => () => { requestSequence.current++; }, [key, enabled]);

  const executeFetch = useCallback(
    async (silent = false): Promise<T | undefined> => {
      if (!key || !enabled) return undefined;
      const sequence = ++requestSequence.current;
      const token = Symbol(key);
      latestRequests.set(key, token);
      const isCurrent = () => keyRef.current === key && requestSequence.current === sequence;
      if (!silent && !memoryCache.has(key)) {
        setLoading(true);
      } else {
        setIsRefreshing(true);
      }
      setError(null);
      try {
        const result = await fetcherRef.current();
        if (latestRequests.get(key) === token) {
          memoryCache.set(key, { data: result, timestamp: Date.now() });
          latestRequests.delete(key);
        }
        if (isCurrent()) setData(result);
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (isCurrent()) setError(e);
        throw e;
      } finally {
        if (latestRequests.get(key) === token) latestRequests.delete(key);
        if (isCurrent()) {
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [key, enabled]
  );

  useEffect(() => {
    if (!key || !enabled) {
      setData(undefined);
      setError(null);
      setLoading(false);
      setIsRefreshing(false);
      return;
    }

    const currentCached = memoryCache.get(key);
    if (currentCached) {
      setData(currentCached.data);
      if (revalidateIfFresh || Date.now() - currentCached.timestamp >= ttlMs) {
        executeFetch(true).catch(() => {});
      }
    } else {
      executeFetch(false).catch(() => {});
    }
  }, [key, enabled, executeFetch, revalidateIfFresh, ttlMs]);

  const mutate = useCallback(
    (newData: T | ((prev: T | undefined) => T), revalidate = false) => {
      if (!key) return;
      requestSequence.current++;
      latestRequests.delete(key);
      setLoading(false);
      setIsRefreshing(false);
      setData((prev) => {
        const resolved = typeof newData === "function" ? (newData as any)(prev) : newData;
        memoryCache.set(key, { data: resolved, timestamp: Date.now() });
        if (revalidate) {
          executeFetch(true).catch(() => {});
        }
        return resolved;
      });
    },
    [key, executeFetch]
  );

  return {
    data,
    loading,
    isRefreshing,
    error,
    updatedAt: key ? memoryCache.get(key)?.timestamp : undefined,
    refresh: executeFetch,
    mutate,
  };
}
