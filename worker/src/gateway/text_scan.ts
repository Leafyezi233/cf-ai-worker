
export function asciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

export function indexOfCaseInsensitive(text: string, needle: string, from: number): number {
  const n = text.length;
  const m = needle.length;
  if (m === 0) return from <= n ? from : -1;
  const first = needle.charCodeAt(0);
  const last = n - m;
  let i = from < 0 ? 0 : from;
  while (i <= last) {
    if (asciiLowerCode(text.charCodeAt(i)) === first) {
      let k = 1;
      while (k < m && asciiLowerCode(text.charCodeAt(i + k)) === needle.charCodeAt(k)) k++;
      if (k === m) return i;
    }
    i++;
  }
  return -1;
}
