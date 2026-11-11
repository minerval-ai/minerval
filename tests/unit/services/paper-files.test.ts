import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";

/**
 * Figures and arXiv source archives (services/paper-files.ts, #912). The
 * bytes are an attacker's to choose, so what is held here is the guard: a
 * file is what its bytes say, an archive is unpacked in memory under a cap
 * and never by name onto a disk, and every refusal is a message an agent
 * can act on. The network is mocked at the guarded fetch.
 */

const { net } = vi.hoisted(() => ({
  net: {
    bodies: new Map<string, { bytes: Buffer; contentType: string | null }>(),
    calls: [] as Array<{ url: string; maxBytes?: number }>,
    error: null as Error | null,
  },
}));

vi.mock("../../../src/services/url-guard.js", () => ({
  fetchPublicBytes: vi.fn(async (url: string, init: { maxBytes?: number } = {}) => {
    net.calls.push({ url, maxBytes: init.maxBytes });
    if (net.error) throw net.error;
    const body = net.bodies.get(url);
    if (!body) throw new Error(`Failed to fetch ${url}: 404`);
    return { ...body, url };
  }),
}));

import {
  ARCHIVE_MAX_DOWNLOAD_BYTES,
  IMAGE_MAX_BYTES,
  ArchiveError,
  classifyViewable,
  clearSourceArchiveCache,
  fetchArxivSource,
  fetchViewable,
  imageProblem,
  imageTokenEstimate,
  parseArxivId,
  readTar,
  safeArchiveName,
  sniffImage,
  unpackEprint,
} from "../../../src/services/paper-files.js";
import { gif, jpeg, png, tar, tarGz, webpVp8x } from "./fixtures/paper-files.js";

beforeEach(() => {
  net.bodies = new Map();
  net.calls = [];
  net.error = null;
  clearSourceArchiveCache();
});

describe("sniffImage", () => {
  it("reads type and size from the header of each format the models take", () => {
    expect(sniffImage(png(640, 480))).toEqual({ mediaType: "image/png", width: 640, height: 480 });
    expect(sniffImage(gif(320, 200))).toEqual({ mediaType: "image/gif", width: 320, height: 200 });
    expect(sniffImage(jpeg(1024, 768))).toEqual({ mediaType: "image/jpeg", width: 1024, height: 768 });
    expect(sniffImage(webpVp8x(800, 600))).toEqual({ mediaType: "image/webp", width: 800, height: 600 });
  });

  it("is null for anything else, however it is dressed", () => {
    expect(sniffImage(Buffer.from("<html><body>not an image</body></html>"))).toBeNull();
    expect(sniffImage(Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    // A PNG signature with nothing after it, and a PNG that claims no size.
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(sniffImage(png(0, 480))).toBeNull();
    // A JPEG whose segments never reach a frame header ends, and does not loop.
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4096, 0xff)]))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, ...Buffer.alloc(32)]))).toBeNull();
  });
});

describe("image limits", () => {
  it("refuses what the model API would reject, saying why", () => {
    expect(imageProblem(png(640, 480), { mediaType: "image/png", width: 640, height: 480 })).toBeNull();
    const big = png(640, 480, IMAGE_MAX_BYTES + 1);
    expect(imageProblem(big, sniffImage(big)!)).toMatch(/7\.0 MB.*at most 7\.0 MB/);
    const wide = png(9000, 100);
    expect(imageProblem(wide, sniffImage(wide)!)).toMatch(/9000 by 100 px.*none over 8000 px/);
  });

  it("estimates the tokens an image costs: a 28 px patch each, under the model's cap", () => {
    expect(imageTokenEstimate({ width: 1000, height: 1000 }, 4784)).toBe(1296);
    expect(imageTokenEstimate({ width: 200, height: 200 }, 4784)).toBe(64);
    expect(imageTokenEstimate({ width: 3840, height: 2160 }, 4784)).toBe(4784);
    expect(imageTokenEstimate({ width: 3840, height: 2160 }, 1568)).toBe(1568);
  });
});

describe("classifyViewable / fetchViewable", () => {
  it("goes by the bytes, not by what the server called them", async () => {
    const image = await classifyViewable(png(640, 480), "https://x.example/fig", "text/html");
    expect(image).toMatchObject({ ok: true, kind: "image", info: { mediaType: "image/png" } });

    // An HTML error page served as an image is not shown as one.
    const page = await classifyViewable(Buffer.from("<!doctype html><html><body>Not found</body></html>"), "https://x.example/a.png", "image/png");
    expect(page).toMatchObject({ ok: false, problem: expect.stringMatching(/an HTML page, not an image/) });

    const eps = await classifyViewable(Buffer.from("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n"), "https://x.example/f.eps", "application/postscript");
    expect(eps).toMatchObject({ ok: false, problem: expect.stringMatching(/PostScript \(EPS\), which no model here can be shown/) });

    const svg = await classifyViewable(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'), "https://x.example/f.svg", "image/svg+xml");
    expect(svg).toMatchObject({ ok: false, problem: expect.stringMatching(/an SVG, which is text/) });

    const other = await classifyViewable(Buffer.from([1, 2, 3, 4]), "https://x.example/blob", null);
    expect(other).toMatchObject({ ok: false, problem: expect.stringMatching(/not a PNG, JPEG, GIF, WebP or PDF \(the server called it nothing\)/) });

    // The %PDF- header on something pdf.js cannot open.
    const broken = await classifyViewable(Buffer.from("%PDF-1.7\nnot really"), "https://x.example/p.pdf", "application/pdf");
    expect(broken).toMatchObject({ ok: false, problem: expect.stringMatching(/could not be opened/) });
  });

  it("fetches under the guard and returns a failure as a message", async () => {
    net.bodies.set("https://arxiv.org/html/2401.00001/x1.png", { bytes: png(900, 600), contentType: "image/png" });
    expect(await fetchViewable("https://arxiv.org/html/2401.00001/x1.png")).toMatchObject({ ok: true, kind: "image" });
    // The page-sized cap of the guard applies: no larger one is asked for.
    expect(net.calls[0]).toEqual({ url: "https://arxiv.org/html/2401.00001/x1.png", maxBytes: undefined });

    net.error = new Error("Refusing 10.0.0.5: resolves to non-public address 10.0.0.5");
    expect(await fetchViewable("http://internal.example/x.png")).toEqual({
      ok: false,
      problem: "Refusing 10.0.0.5: resolves to non-public address 10.0.0.5",
    });
  });
});

describe("parseArxivId", () => {
  it("takes an id or the paper's arxiv.org URL", () => {
    expect(parseArxivId("2401.01234")).toBe("2401.01234");
    expect(parseArxivId(" arXiv:2401.01234v3 ")).toBe("2401.01234v3");
    expect(parseArxivId("hep-th/9901001")).toBe("hep-th/9901001");
    expect(parseArxivId("math.AG/0601001v2")).toBe("math.AG/0601001v2");
    expect(parseArxivId("https://arxiv.org/abs/2401.01234v2")).toBe("2401.01234v2");
    expect(parseArxivId("https://arxiv.org/pdf/2401.01234.pdf")).toBe("2401.01234");
    expect(parseArxivId("https://arxiv.org/html/2401.01234v1/")).toBe("2401.01234v1");
    expect(parseArxivId("http://export.arxiv.org/e-print/hep-th/9901001")).toBe("hep-th/9901001");
  });

  it("is null for anything that would steer the fetch elsewhere", () => {
    for (const bad of [
      "",
      "https://evil.example/e-print/2401.01234",
      "https://arxiv.org.evil.example/abs/2401.01234",
      "2401.01234/../../etc/passwd",
      "../2401.01234",
      "2401.01234?x=1",
      "http://169.254.169.254/latest/meta-data",
      "2401.1",
    ]) {
      expect(parseArxivId(bad), bad).toBeNull();
    }
  });
});

describe("readTar", () => {
  it("lists regular files with their kind, each a view into the archive", () => {
    const archive = readTar(
      tar([
        { name: "main.tex", data: "\\documentclass{article}\n$a < b$\n" },
        { name: "figs/", type: "5" },
        { name: "figs/fig1.png", data: png(800, 600) },
        { name: "./data/points.csv", data: "x,y\n1,2\n" },
        { name: "figs/fig2.eps", data: "%!PS-Adobe-3.0 EPSF-3.0\n0 0 moveto\n" },
        { name: "blob.bin", data: Buffer.from([0, 1, 2, 3, 0, 0, 0]) },
      ])
    );
    expect(archive.files.map((f) => [f.name, f.kind])).toEqual([
      ["main.tex", "text"],
      ["figs/fig1.png", "image"],
      ["data/points.csv", "text"],
      ["figs/fig2.eps", "text"],
      ["blob.bin", "binary"],
    ]);
    expect(archive).toMatchObject({ skipped: 0, truncated: false });
    expect(archive.files[0]!.bytes.toString("utf8")).toBe("\\documentclass{article}\n$a < b$\n");
  });

  it("leaves out entries whose names climb out or are absolute, and never follows a link", () => {
    const archive = readTar(
      tar([
        { name: "../../etc/cron.d/evil", data: "* * * * * root sh\n" },
        { name: "/etc/passwd", data: "root::0:0\n" },
        { name: "a/../../b.tex", data: "x" },
        { name: "C:\\Windows\\x.tex", data: "x" },
        { name: "link.tex", type: "2", linkname: "/etc/shadow" },
        { name: "hard.tex", type: "1", linkname: "../../secret" },
        { name: "ok.tex", data: "fine" },
      ])
    );
    expect(archive.files.map((f) => f.name)).toEqual(["ok.tex"]);
    expect(archive.skipped).toBe(4);
  });

  it("applies a GNU long name to the entry it precedes, and guards that name too", () => {
    const long = `${"deep/".repeat(30)}table.tex`;
    const archive = readTar(
      tar([
        { name: "././@LongLink", type: "L", data: `${long}\0` },
        { name: "truncated-name", data: "T" },
        { name: "././@LongLink", type: "L", data: "../../outside.tex\0" },
        { name: "innocent.tex", data: "X" },
        { name: "after.tex", data: "A" },
      ])
    );
    expect(archive.files.map((f) => f.name)).toEqual([long, "after.tex"]);
    expect(archive.skipped).toBe(1);
  });

  it("stops at a cut or corrupt archive and keeps what came before", () => {
    const whole = tar([
      { name: "a.tex", data: "A".repeat(600) },
      { name: "b.tex", data: "B".repeat(600) },
    ]);
    // Cut inside the second file's data.
    const cut = readTar(whole.subarray(0, 512 + 1024 + 512 + 100));
    expect(cut.files.map((f) => f.name)).toEqual(["a.tex"]);
    expect(cut.truncated).toBe(true);

    // A header claiming more than the archive holds cannot read past its end.
    const lying = Buffer.from(whole);
    lying.write("77777777777\0", 124, "latin1");
    expect(readTar(lying)).toMatchObject({ files: [], truncated: true });
  });
});

describe("safeArchiveName", () => {
  it("normalises a plain relative name and refuses the rest", () => {
    expect(safeArchiveName("./figs/./a.png")).toBe("figs/a.png");
    expect(safeArchiveName("figs\\a.png")).toBe("figs/a.png");
    for (const bad of ["", "/abs", "..", "a/../b", "../a", "a//b", "a\0b", "D:/x"]) {
      expect(safeArchiveName(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("unpackEprint", () => {
  it("unpacks a gzipped tar", async () => {
    const archive = await unpackEprint(tarGz([{ name: "main.tex", data: "hello" }, { name: "t.dat", data: "1 2\n" }]));
    expect(archive.files.map((f) => f.name)).toEqual(["main.tex", "t.dat"]);
  });

  it("takes a single gzipped TeX file as an archive of one", async () => {
    const tex = "\\documentclass{article}\\begin{document}One file.\\end{document}\n";
    const one = await unpackEprint(gzipSync(Buffer.from(tex)), { id: "hep-th/9901001" });
    expect(one.files).toHaveLength(1);
    expect(one.files[0]).toMatchObject({ name: "hep-th_9901001.tex", kind: "text" });
    expect(one.files[0]!.bytes.toString("utf8")).toBe(tex);
  });

  it("refuses a body that inflates past the cap, without inflating it", async () => {
    // 64 MB of zeros is about 62 KB gzipped: the shape of a decompression bomb.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200_000);
    await expect(unpackEprint(bomb, { maxUnpackedBytes: 1024 * 1024 })).rejects.toThrow(
      /inflates to more than 1\.0 MB and was not unpacked/
    );
    await expect(unpackEprint(bomb, { maxUnpackedBytes: 1024 * 1024 })).rejects.toBeInstanceOf(ArchiveError);
  });

  it("says what is wrong with a damaged gzip, a bare PDF, and anything else", async () => {
    const good = tarGz([{ name: "main.tex", data: "hello ".repeat(500) }]);
    const damaged = Buffer.concat([good.subarray(0, 40), Buffer.alloc(40, 0x41), good.subarray(80)]);
    await expect(unpackEprint(damaged)).rejects.toThrow(/damaged and could not be unpacked/);
    await expect(unpackEprint(good.subarray(0, good.length - 12))).rejects.toThrow(/damaged and could not be unpacked/);
    await expect(unpackEprint(Buffer.from("%PDF-1.5\n..."))).rejects.toThrow(/no source for this paper, only its PDF/);
    await expect(unpackEprint(Buffer.from("<html>rate limited</html>"))).rejects.toThrow(/not a gzip archive/);
  });
});

describe("fetchArxivSource", () => {
  const eprint = "https://arxiv.org/e-print/2401.01234";

  it("fetches the e-print under the guard with the archive cap, and once for several reads", async () => {
    net.bodies.set(eprint, { bytes: tarGz([{ name: "main.tex", data: "hello" }]), contentType: "application/gzip" });
    const first = await fetchArxivSource("https://arxiv.org/abs/2401.01234");
    expect(first).toMatchObject({ ok: true, id: "2401.01234" });
    expect(net.calls).toEqual([{ url: eprint, maxBytes: ARCHIVE_MAX_DOWNLOAD_BYTES }]);
    await fetchArxivSource("2401.01234");
    expect(net.calls).toHaveLength(1);
    // The cached archive ages out.
    let now = Date.now();
    await fetchArxivSource("2401.01234", () => (now += 16 * 60_000));
    expect(net.calls).toHaveLength(2);
  });

  it("never fetches for something that is not an arXiv id", async () => {
    const res = await fetchArxivSource("https://evil.example/e-print/2401.01234");
    expect(res).toMatchObject({ ok: false, problem: expect.stringMatching(/not an arXiv identifier/) });
    expect(net.calls).toEqual([]);
  });

  it("turns an oversize download, a bad archive, and a fetch failure into messages", async () => {
    net.error = new Error(`Response from ${eprint} exceeds ${ARCHIVE_MAX_DOWNLOAD_BYTES} bytes`);
    expect(await fetchArxivSource("2401.01234")).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/over 50\.0 MB and was not fetched.*memory of the server/),
    });
    net.error = null;
    net.bodies.set(eprint, { bytes: Buffer.from("%PDF-1.5\n"), contentType: "application/pdf" });
    expect(await fetchArxivSource("2401.01234")).toMatchObject({ ok: false, problem: expect.stringMatching(/only its PDF/) });
    expect(await fetchArxivSource("2401.99999")).toEqual({
      ok: false,
      problem: "Failed to fetch https://arxiv.org/e-print/2401.99999: 404",
    });
  });
});
