import express from "express";
import http from "http";
import { AddressInfo } from "net";

import {
  LibraryFeatureRequestError,
  type ArtistPortraitFeaturePort,
  type ArtistPortraitImage,
  type ArtistPortraitReference,
  type ArtistPortraitWidth,
} from "../../../libraryFeatures";
import { createArtistPortraitRouter } from "../artist-portrait";
import { EDITORIAL_WIDE_ARTWORK_REFERENCE_PREFIX } from "../../../../shared/editorialItemContracts";

/**
 * A portrait reference in the form the producer really mints: the shared
 * contract's namespace tag, then a bare library key. The route validates
 * none of this — the path segment is opaque here, and the feature port owns
 * the grammar — but a fixture in the real form is what keeps this suite
 * exercising the path a browser actually asks for.
 */
const REFERENCE = `${EDITORIAL_WIDE_ARTWORK_REFERENCE_PREFIX}abcd1234`;

/** A read the port recorded, so a test can see what the route asked for. */
interface RecordedRead {
  readonly reference: ArtistPortraitReference;
  readonly width: ArtistPortraitWidth;
}

class TestPortraitSourceError extends LibraryFeatureRequestError {
  public readonly code = "ARTIST_PORTRAIT_SOURCE_UNAVAILABLE";

  public readonly statusCode = 502;
}

class TestPortraitRequestError extends LibraryFeatureRequestError {
  public readonly code = "INVALID_ARTIST_PORTRAIT_REQUEST";

  public readonly statusCode = 400;
}

/**
 * A port whose every read runs `answer`, so a case can hand back a portrait,
 * the clean negative, or a feature failure through the same seam.
 */
function testPort(answer: () => ArtistPortraitImage | null): {
  port: ArtistPortraitFeaturePort;
  reads: RecordedRead[];
} {
  const reads: RecordedRead[] = [];
  const port: ArtistPortraitFeaturePort = {
    read: (reference, width) => {
      reads.push({ reference, width });
      return Promise.resolve(answer());
    },
  };
  return { port, reads };
}

const PORTRAIT: ArtistPortraitImage = {
  data: Buffer.from("JPEG_BYTES"),
  contentType: "image/jpeg",
  shape: "wide",
};

function startApp(
  portraits?: ArtistPortraitFeaturePort
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use("/api/artist-portrait", createArtistPortraitRouter(portraits));
  // Anything unmatched is an API miss, as in the real app.
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe("GET /api/artist-portrait/wide/:key", () => {
  let app: { url: string; close: () => Promise<void> };

  afterEach(async () => {
    await app.close();
  });

  it("serves the portrait bytes with its own content type", async () => {
    const { port } = testPort(() => PORTRAIT);
    app = await startApp(port);
    const res = await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("JPEG_BYTES");
  });

  it("passes through cache headers a portrait can be held under", async () => {
    const { port } = testPort(() => PORTRAIT);
    app = await startApp(port);
    const res = await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
  });

  it("never tells a browser this URL is immutable — a re-pair changes what it means", async () => {
    const { port } = testPort(() => PORTRAIT);
    app = await startApp(port);
    const res = await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    const cacheControl = res.headers.get("cache-control") ?? "";
    // The path carries a portrait key and no Core identity, so the same URL
    // names a different photograph once a different library is paired. A
    // browser must be able to correct itself, and soon.
    expect(cacheControl).not.toMatch(/immutable/u);
    expect(cacheControl).not.toMatch(/\bpublic\b/u);
    const maxAge = /max-age=(\d+)/u.exec(cacheControl)?.[1];
    expect(maxAge).toBeDefined();
    expect(Number(maxAge)).toBeLessThanOrEqual(600);
  });

  it("asks for the wide shape and never lets a caller name a different one", async () => {
    const { port, reads } = testPort(() => PORTRAIT);
    app = await startApp(port);
    await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    expect(reads).toEqual([
      { reference: { key: REFERENCE, shape: "wide" }, width: 2048 },
    ]);
  });

  it("refuses a request that tries to name a shape of its own", async () => {
    const { port, reads } = testPort(() => PORTRAIT);
    app = await startApp(port);
    const res = await fetch(
      `${app.url}/api/artist-portrait/wide/${REFERENCE}?shape=square`
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details?: string }).details).toBe(
      "INVALID_ARTIST_PORTRAIT_REQUEST"
    );
    expect(reads).toEqual([]);
  });

  it("has no path that serves any shape but wide", async () => {
    const { port, reads } = testPort(() => PORTRAIT);
    app = await startApp(port);
    for (const path of [`square/${REFERENCE}`, `tall/${REFERENCE}`, REFERENCE]) {
      const res = await fetch(`${app.url}/api/artist-portrait/${path}`);
      expect(res.status).toBe(404);
    }
    expect(reads).toEqual([]);
  });

  it("takes a width from the closed list and refuses anything else", async () => {
    const { port, reads } = testPort(() => PORTRAIT);
    app = await startApp(port);

    const accepted = await fetch(
      `${app.url}/api/artist-portrait/wide/${REFERENCE}?width=512`
    );
    expect(accepted.status).toBe(200);
    expect(reads[0]?.width).toBe(512);

    for (const width of ["777", "0", "-1", "1024.5", "99999", "", "2048px", "1e3"]) {
      const res = await fetch(
        `${app.url}/api/artist-portrait/wide/${REFERENCE}?width=${encodeURIComponent(width)}`
      );
      expect(res.status).toBe(400);
    }
    expect(reads).toHaveLength(1);
  });

  it("answers a clean negative with a plain 404 that is never cached", async () => {
    const { port } = testPort(() => null);
    app = await startApp(port);
    const res = await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { details?: string }).details).toBe(
      "ARTIST_PORTRAIT_NOT_FOUND"
    );
  });

  it("keeps a real fault distinguishable from an artist with no portrait", async () => {
    const { port } = testPort(() => {
      throw new TestPortraitSourceError("the library could not be reached");
    });
    app = await startApp(port);
    const res = await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; details?: string };
    expect(body.details).toBe("ARTIST_PORTRAIT_SOURCE_UNAVAILABLE");
    expect(body.error).toBe("the library could not be reached");
  });

  it("serves the status and reason the feature itself chose", async () => {
    const { port } = testPort(() => {
      throw new TestPortraitRequestError(
        "that is not an artist portrait reference"
      );
    });
    app = await startApp(port);
    const res = await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details?: string }).details).toBe(
      "INVALID_ARTIST_PORTRAIT_REQUEST"
    );
  });

  it("fails closed, and never throws, when the feature layer is absent", async () => {
    app = await startApp(undefined);
    const res = await fetch(`${app.url}/api/artist-portrait/wide/${REFERENCE}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; details?: string };
    expect(body.details).toBe("FEATURE_UNAVAILABLE");
    expect(body.error).toMatch(/not part of this build/u);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("still refuses a malformed request when the feature layer is absent", async () => {
    app = await startApp(undefined);
    const res = await fetch(
      `${app.url}/api/artist-portrait/wide/${REFERENCE}?width=777`
    );
    expect(res.status).toBe(400);
  });
});
