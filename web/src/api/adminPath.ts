export function adminBase(): string {
  return "/" + window.location.pathname.split("/")[1];
}
export function adminApiPath(path: string): string {
  if (!path.startsWith("/api/")) throw new Error("Invalid management API path");
  return adminBase() + path;
}
