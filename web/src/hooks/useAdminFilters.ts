import { useCallback, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function readAdminFilters(search: string, defaults: Record<string, string>): Record<string, string> {
  const params = new URLSearchParams(search);
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, params.get(`list_${key}`) ?? value]));
}

export function writeAdminFilters(search: string, defaults: Record<string, string>, values: Record<string, string>): string {
  const params = new URLSearchParams(search);
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = values[key] ?? fallback;
    if (value === fallback) params.delete(`list_${key}`);
    else params.set(`list_${key}`, value);
  }
  return params.toString();
}

export function useAdminFilters(defaults: Record<string, string>) {
  const location = useLocation();
  const navigate = useNavigate();
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const pending = useRef({ observed: location.search, search: location.search });
  if (pending.current.observed !== location.search) {
    pending.current = { observed: location.search, search: location.search };
  }
  const apply = useCallback((values: Record<string, string>) => {
    const search = writeAdminFilters(pending.current.search, defaultsRef.current, values);
    pending.current.search = search ? `?${search}` : "";
    navigate({ pathname: location.pathname, search: pending.current.search, hash: location.hash }, { replace: true });
  }, [navigate, location.pathname, location.hash]);
  const setFilter = useCallback((name: string, value: string) => {
    if (!Object.prototype.hasOwnProperty.call(defaultsRef.current, name)) return;
    apply({ ...readAdminFilters(pending.current.search, defaultsRef.current), [name]: value });
  }, [apply]);
  const reset = useCallback(() => apply(defaultsRef.current), [apply]);
  const defaultsKey = Object.entries(defaults).map(([key, value]) => `${key.length}:${key}${value.length}:${value}`).join("|");
  const filters = useMemo(() => readAdminFilters(location.search, defaultsRef.current), [location.search, defaultsKey]);
  return [filters, setFilter, reset] as const;
}
