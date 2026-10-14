import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { parseMhtml, decodeQuotedPrintable, stripScripts, archiveResponse, archiveKey, type WebArchive } from "../src/capture/mhtml.js";
import { captureSite, type CaptureResult } from "../src/capture/capture.js";

// Issue #49 — clone a page from a saved .mhtml web archive (e.g. a page behind a login).

const CRLF = "\r\n";
function mhtml(parts: Array<{ type: string; location: string; encoding?: string; body: string }>, snapshot?: string): string {
  const b = "----MultipartBoundary--test123----";
  const head = [
    "From: <Saved by Blink>",
    ...(snapshot ? [`Snapshot-Content-Location: ${snapshot}`] : []),
    "Subject: Test",
    "MIME-Version: 1.0",
    "Content-Type: multipart/related;",
    `\ttype="text/html";`,
    `\tboundary="${b}"`,
  ].join(CRLF);
  const body = parts.map((p) => [
    `--${b}`,
    `Content-Type: ${p.type}`,
    `Content-Transfer-Encoding: ${p.encoding ?? "binary"}`,
    `Content-Location: ${p.location}`,
    "",
    p.body,
  ].join(CRLF)).join(CRLF);
  return head + CRLF + CRLF + body + CRLF + `--${b}--` + CRLF;
}

describe("parseMhtml", () => {
  it("reads the page URL, the main document and resources (folded headers, QP + base64)", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const a = parseMhtml(mhtml([
      { type: "text/html; charset=utf-8", location: "https://app.example.com/dash", encoding: "quoted-printable", body: "<html><body><h1 class=3D\"t\">Caf=C3=A9 dashboard</h1>=\r\n<p>x</p></body></html>" },
      { type: "text/css", location: "https://app.example.com/a.css", body: "h1{color:red}" },
      { type: "image/png", location: "https://cdn.example.com/logo.png", encoding: "base64", body: png.toString("base64").replace(/(.{4})/g, "$1\r\n") },
    ], "https://app.example.com/dash"));
    assert.equal(a.url, "https://app.example.com/dash");
    assert.equal(a.main.body.toString("utf8"), '<html><body><h1 class="t">Café dashboard</h1><p>x</p></body></html>');
    assert.equal(a.resources.size, 3);
    assert.equal(a.resources.get("https://app.example.com/a.css")?.body.toString(), "h1{color:red}");
    assert.ok(a.resources.get("https://cdn.example.com/logo.png")?.body.equals(png), "binary survives base64 + line breaks");
  });

  it("falls back to the first HTML part when Snapshot-Content-Location is absent", () => {
    const a = parseMhtml(mhtml([
      { type: "text/css", location: "https://x.test/s.css", body: "" },
      { type: "text/html", location: "https://x.test/page", body: "<p>hi</p>" },
    ]));
    assert.equal(a.url, "https://x.test/page");
  });

  it("counts cid: frame parts without replaying them", () => {
    const a = parseMhtml(mhtml([
      { type: "text/html", location: "https://x.test/", body: "<iframe src=\"cid:frame-1@mhtml.blink\"></iframe>" },
      { type: "text/html", location: "cid:frame-1@mhtml.blink", body: "<p>frame</p>" },
    ], "https://x.test/"));
    assert.equal(a.frameCount, 1);
    assert.equal(a.resources.size, 1);
  });

  it("rejects files that aren't MHTML archives", () => {
    assert.throws(() => parseMhtml("<html></html>"), /not an MHTML archive/);
    assert.throws(() => parseMhtml("Content-Type: text/html\r\n\r\n<p>"), /multipart\/related/);
    assert.throws(() => parseMhtml(mhtml([{ type: "text/html", location: "file:///C:/x.html", body: "<p>" }])), /must be http/);
  });

  it("decodes quoted-printable soft breaks and escapes", () => {
    assert.equal(decodeQuotedPrintable("a=3Db=\r\nc=E2=82=AC").toString("utf8"), "a=bc€");
  });

  it("strips script elements but keeps the rendered DOM", () => {
    assert.equal(stripScripts('<p>a</p><script src="x.js"></script><script>\nboot()\n</script ><p>b</p>'), "<p>a</p><p>b</p>");
  });

  it("serves archived resources (fragment-insensitive) and nothing else", () => {
    const a: WebArchive = parseMhtml(mhtml([
      { type: "text/html", location: "https://x.test/", body: "<p>ok</p><script>boom()</script>" },
      { type: "font/woff2", location: "https://x.test/f.woff2", body: "wOF2" },
    ], "https://x.test/"));
    assert.equal(archiveKey("https://x.test/f.woff2#v1"), "https://x.test/f.woff2");
    assert.equal(archiveResponse(a, "https://x.test/f.woff2#v1")?.body.toString(), "wOF2");
    assert.equal(archiveResponse(a, "https://x.test/")?.body.toString(), "<p>ok</p>", "main HTML is served without scripts");
    assert.equal(archiveResponse(a, "https://x.test/api/me"), null, "anything not archived is blocked");
  });
});

describe("captureSite from an .mhtml archive (offline replay)", () => {
  let server: Server;
  let url = "";
  let outDir = "";
  let archive: WebArchive;
  let capture: CaptureResult;
  let hitsDuringCapture = 0;
  let capturing = false;
  const png = readFileSync(join(import.meta.dirname, "..", "fixtures", "seo-icon.png"));

  before(async () => {
    server = createServer((req, res) => {
      if (capturing) hitsDuringCapture++;
      if (req.url === "/style.css") { res.writeHead(200, { "content-type": "text/css" }); res.end("h1{color:rgb(200, 0, 0);font-size:40px} .card{padding:24px;border:1px solid #ccc}"); return; }
      if (req.url === "/logo.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(png); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Members area</title><link rel="stylesheet" href="/style.css"></head>
        <body><h1>Members-only dashboard</h1><div class="card"><img src="/logo.png" width="64" height="64" alt="logo"><p>Balance overview</p></div>
        <script>document.querySelector(".card").insertAdjacentHTML("beforeend", "<p class=dyn>Rendered by script</p>")</script></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

    // "Save as → Webpage, Single File": Chromium's own MHTML serializer, after the page's script ran.
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "load" });
      const cdp = await page.context().newCDPSession(page);
      const { data } = await cdp.send("Page.captureSnapshot", { format: "mhtml" }) as { data: string };
      archive = parseMhtml(Buffer.from(data, "latin1"));
    } finally {
      await browser.close();
    }

    outDir = mkdtempSync(join(tmpdir(), "ditto-mhtml-"));
    capturing = true;
    capture = await captureSite({ url: archive.url, outDir, viewports: [1280], breakpoints: false, screenshots: false, archive });
    capturing = false;
  });

  after(async () => {
    server?.close();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("parses Chromium's real MHTML output", () => {
    assert.equal(archiveKey(archive.url), archiveKey(url));
    assert.ok(archive.resources.has(archiveKey(url + "style.css")), "stylesheet archived");
    assert.ok(archive.resources.has(archiveKey(url + "logo.png")), "image archived");
  });

  it("never contacts the origin while capturing", () => {
    assert.equal(hitsDuringCapture, 0, `origin received ${hitsDuringCapture} request(s) during an archive capture`);
  });

  it("captures the rendered page and its assets from the archive", () => {
    assert.ok(capture.perViewport[0]!.nodeCount > 5, "DOM captured");
    const img = capture.assets.find((a) => a.url === url + "logo.png");
    assert.ok(img?.storedAs, "image stored from the archive");
    assert.ok(readFileSync(join(outDir, "assets-store", img!.storedAs!)).equals(png), "image bytes are the archived ones");
    assert.ok(capture.cssTexts.length >= 1, "stylesheet stored from the archive");
  });

  it("keeps the script-rendered content exactly once (scripts are not re-run)", () => {
    const captureDir = join(outDir, "capture");
    const dump = readdirSync(captureDir).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(captureDir, f), "utf8")).join("\n");
    assert.ok(dump.includes("Members-only dashboard"), "static text captured");
    assert.equal(dump.split("Rendered by script").length - 1 >= 1, true, "script-rendered text captured");
    const perSnapshot = readdirSync(captureDir).filter((f) => /^dom-\d+\.json$/.test(f));
    assert.ok(perSnapshot.length >= 1, "per-viewport DOM snapshot written");
    for (const f of perSnapshot) {
      const n = readFileSync(join(captureDir, f), "utf8").split("Rendered by script").length - 1;
      assert.ok(n <= 1, `${f}: script output duplicated (${n}×) — the archived script must not run again`);
    }
  });
});
