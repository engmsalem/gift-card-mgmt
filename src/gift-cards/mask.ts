/** Keeps the first character of the local part and the whole domain: `alice@x.com` -> `a***@x.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const first = String.fromCodePoint(email.codePointAt(0) as number);
  return `${first}***${email.slice(at)}`;
}
