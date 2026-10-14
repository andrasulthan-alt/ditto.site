/**
 * MHTML (web archive) input — issue #49.
 *
 * Some pages can't be captured from a public URL: they sit behind a login, or aren't publicly
 * reachable at all. A browser can still save the rendered page as a single-file web archive
 * (Chrome/Edge "Save as → Webpage, Single File", `.mhtml`). This module parses that archive into a
 * URL → resource map so the capture can replay the page OFFLINE: every request is answered from the
 * archive and anything missing is blocked, so the origin (and the user's session there) is never
 * contacted.
 *
 * Format: an RFC 2557 `multipart/related` MIME message. The root headers name the page
 * (`Snapshot-Content-Location`, written by Blink) and the boundary; each part carries
 * `Content-Type`, `Content-Location` (the resource's original URL, or `cid:` for frames) and a
 * `Content-Transfer-Encoding` of `quoted-printable`, `base64`, `binary`, `7bit` or `8bit`.
 *
 * Pure (no browser, no network) so it unit-tests directly.
 */

export type ArchivedResource = {
  url: string;
  contentType: string;
  body: Buffer;
};

export type WebArchive = {
  /** The page's original URL (Snapshot-Content-Location, else the main part's Content-Location). */
  url: string;
  /** Archived resources keyed by normalized URL (see `archiveKey`). Includes the main document. */
  resources: Map<string, ArchivedResource>;
  /** The main HTML document. */
  main: ArchivedResource;
  /** Resources that live only at `cid:` locations (saved iframes); not replayed in v1. */
  frameCount: number;
};

/** Normalize a URL for archive lookup: drop the fragment (never sent to a server). */
export function archiveKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url.split("#")[0]!;
  }
}

type Headers = Map<string, string>;

/** Parse a header block (with RFC 5322 line folding) into a lower-cased name → value map. */
function parseHeaders(block: string): Headers {
  const out: Headers = new Map();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
  }
  return out;
}

/** A named parameter of a structured header value, e.g. `boundary` of a Content-Type. */
function headerParam(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i");
  const m = re.exec(value);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** Decode a quoted-printable body to bytes (soft line breaks + `=XX` escapes). */
export function decodeQuotedPrintable(s: string): Buffer {
  const noSoft = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    const ch = noSoft[i]!;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(noSoft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // QP lines are 7-bit; code points above 0xFF don't occur in a conforming body. Keep latin1.
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(raw: string, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").toLowerCase()) {
    case "base64":
      return Buffer.from(raw.replace(/\s+/g, ""), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(raw);
    default: // binary / 7bit / 8bit / absent
      return Buffer.from(raw, "latin1");
  }
}

/** Parse an MHTML archive. Throws a descriptive error for a file that isn't one. */
export function parseMhtml(input: Buffer | string): WebArchive {
  // latin1 maps bytes 1:1 to code units, so binary parts survive and offsets stay byte-exact.
  const text = typeof input === "string" ? input : input.toString("latin1");
  const headEnd = text.search(/\r?\n\r?\n/);
  if (headEnd < 0) throw new Error("not an MHTML archive: missing header block");
  const root = parseHeaders(text.slice(0, headEnd));
  const rootType = root.get("content-type") ?? "";
  if (!/multipart\/related/i.test(rootType)) {
    throw new Error(`not an MHTML archive: expected multipart/related, got "${rootType || "none"}"`);
  }
  const boundary = headerParam(rootType, "boundary");
  if (!boundary) throw new Error("not an MHTML archive: multipart/related without a boundary");

  const delim = `--${boundary}`;
  const resources = new Map<string, ArchivedResource>();
  let firstHtml: ArchivedResource | undefined;
  let frameCount = 0;

  let pos = text.indexOf(delim);
  while (pos >= 0) {
    const after = pos + delim.length;
    if (text.startsWith("--", after)) break; // closing delimiter
    const next = text.indexOf(delim, after);
    if (next < 0) break;
    // Part = everything between this delimiter line and the CRLF before the next delimiter.
    let part = text.slice(after, next).replace(/^\r?\n/, "");
    part = part.replace(/\r?\n$/, "");
    pos = next;

    const sep = part.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const headers = parseHeaders(part.slice(0, sep));
    const bodyStart = part.slice(sep).match(/^\r?\n\r?\n/)![0].length + sep;
    const location = headers.get("content-location");
    if (!location) continue;
    if (/^cid:/i.test(location)) { frameCount++; continue; }
    const contentType = (headers.get("content-type") ?? "application/octet-stream").trim();
    const res: ArchivedResource = {
      url: location,
      contentType,
      body: decodeBody(part.slice(bodyStart), headers.get("content-transfer-encoding")),
    };
    const key = archiveKey(location);
    if (!resources.has(key)) resources.set(key, res); // first occurrence wins
    if (!firstHtml && /^text\/html/i.test(contentType)) firstHtml = res;
  }

  const snapshot = root.get("snapshot-content-location");
  const main = (snapshot && resources.get(archiveKey(snapshot))) || firstHtml;
  if (!main) throw new Error("MHTML archive has no HTML document");
  const url = snapshot || main.url;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`MHTML archive page URL must be http(s), got "${url}"`);
  }
  return { url, resources, main, frameCount };
}

/** Remove script elements from the archived HTML. The archive is the page AFTER its scripts ran;
 *  re-running them offline (every API call blocked) would typically re-render the page into an
 *  error or empty state. The capture's own init scripts and evaluations are unaffected. */
export function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/>/gi, "");
}

/** The response to serve for a request in archive mode, or null when it must be blocked. */
export function archiveResponse(archive: WebArchive, url: string): { status: number; contentType: string; body: Buffer } | null {
  const res = archive.resources.get(archiveKey(url));
  if (!res) return null;
  if (res === archive.main || /^text\/html/i.test(res.contentType)) {
    // latin1 round-trips every byte unchanged, so this is charset-agnostic (UTF-8, Shift_JIS, …):
    // `<script>` markup is ASCII and matches the same way in any ASCII-compatible encoding.
    const html = stripScripts(res.body.toString("latin1"));
    return { status: 200, contentType: res.contentType, body: Buffer.from(html, "latin1") };
  }
  return { status: 200, contentType: res.contentType, body: res.body };
}
