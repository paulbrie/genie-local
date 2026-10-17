// Pure, dependency-free: safe to import from server and client.

/** "Chrome 141 on macOS", "Safari 18 on iPhone", "curl 8.5", … from a User-Agent. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown browser";
  const v = (re: RegExp) => re.exec(ua)?.[1]?.split(".")[0];

  let browser: string;
  if (/HeadlessChrome/.test(ua)) browser = `Headless Chrome ${v(/HeadlessChrome\/([\d.]+)/) ?? ""}`;
  else if (/Edg\//.test(ua)) browser = `Edge ${v(/Edg\/([\d.]+)/) ?? ""}`;
  else if (/OPR\//.test(ua)) browser = `Opera ${v(/OPR\/([\d.]+)/) ?? ""}`;
  else if (/Firefox\//.test(ua)) browser = `Firefox ${v(/Firefox\/([\d.]+)/) ?? ""}`;
  else if (/Chrome\//.test(ua)) browser = `Chrome ${v(/Chrome\/([\d.]+)/) ?? ""}`;
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = `Safari ${v(/Version\/([\d.]+)/) ?? ""}`;
  else if (/^curl\//.test(ua)) return `curl ${v(/^curl\/([\d.]+)/) ?? ""}`.trim();
  else if (/^node|undici/i.test(ua)) return "Node.js script";
  else return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;

  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return `${browser.trim()}${os ? ` on ${os}` : ""}`;
}
