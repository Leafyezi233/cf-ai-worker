
const FORMULA_PREFIXES = ["=", "+", "-", "@", "~"];

const WHITESPACE_STARTERS = [String.fromCharCode(9), String.fromCharCode(13)];


export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const str = String(value);
  if (str.length === 0) return "";
  if (WHITESPACE_STARTERS.indexOf(str[0]) >= 0) return "'" + str;
  const firstVisible = str.replace(/^[\s\uFEFF]+/, "")[0];
  if (firstVisible === undefined) return "";
  if (FORMULA_PREFIXES.indexOf(firstVisible) >= 0) return "'" + str;
  return str;
}
