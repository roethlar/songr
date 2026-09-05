import express from "express";
import type { Server } from "http";
import { AddressInfo } from "net";

import type {
  LibraryOnDemandRoot,
  LibraryOpenOutcome,
  LibraryReadTrigger,
  LibraryRootsOutcome,
  LibrarySnapshot,
} from "../../../../core/library/LibrarySource";
import { normalizeLibraryOpenResponse } from "../../../../shared/libraryOpenContracts";
import {
  LIBRARY_ROOTS_CONTRACT,
  normalizeLibraryRootsResponse,
  normalizeLibraryRootsUnavailable,
} from "../../../../shared/libraryRootsContracts";
import { createLibraryRouter, type LibraryRootsPort } from "../library";

const GENERATION = "gen-1";

/** Typed so a fixture cannot drift from the outcome union it stands in for. */
function found(value: LibrarySnapshot): LibraryRootsOutcome {
  return { kind: "snapshot", snapshot: value };
}

function snapshot(generation = GENERATION): LibrarySnapshot {
  return {
    generation,
    coreId: "core-a",
    readAt: 1_756_000_000_000,
    artists: {
      count: 2,
      rows: [
        {
          ref: { generation, token: `${generation}-a1` },
          title: "Invented Artist A",
          subtitle: "3 Albums",
          imageKey: "image-a1",
        },
        {
          ref: { generation, token: `${generation}-a2` },
          title: "Invented Artist B",
          subtitle: "1 Album",
        },
      ],
    },
    albums: {
      count: 1,
      rows: [
        {
          ref: { generation, token: `${generation}-b1` },
          title: "Invented Album",
          subtitle: "Invented Artist A",
        },
      ],
    },
  };
}

interface Harness {
  url: string;
  close(): Promise<void>;
  port: {
    current: jest.Mock<LibrarySnapshot | null, []>;
    roots: jest.Mock<Promise<LibraryRootsOutcome>, [LibraryReadTrigger]>;
    refresh: jest.Mock<Promise<LibraryRootsOutcome>, [LibraryReadTrigger]>;
    revalidate: jest.Mock<Promise<LibraryRootsOutcome>, [LibraryReadTrigger]>;
    open: jest.Mock<Promise<LibraryOpenOutcome>, [{ generation: string; token: string }]>;
    openRoot: jest.Mock<Promise<LibraryOpenOutcome>, [LibraryOnDemandRoot]>;
  };
}

async function serve(library?: Partial<LibraryRootsPort>): Promise<Harness> {
  const held = snapshot();
  const port = {
    current: jest.fn(() => held),
    roots: jest.fn(async () => found(held)),
    refresh: jest.fn(async () => found(held)),
    revalidate: jest.fn(async () => found(held)),
    open: jest.fn(async () => ({ kind: "stale" }) as LibraryOpenOutcome),
    openRoot: jest.fn(async () => ({ kind: "stale" }) as LibraryOpenOutcome),
    ...library,
  } as Harness["port"];
  const app = express();
  // The real app parses JSON bodies before the router sees them
  // (`src/server/http/app.ts`); a harness that did not would be testing a
  // route that does not exist.
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/library", createLibraryRouter(port as unknown as LibraryRootsPort));
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("GET /api/library/roots", () => {
  it("serves the snapshot with references and Roon's own text", async () => {
    const app = await serve();
    try {
      const response = await fetch(`${app.url}/api/library/roots`);
      expect(response.status).toBe(200);
      const body = normalizeLibraryRootsResponse(await response.json());
      if (body === null || body.kind !== "snapshot") {
        throw new Error("the route served something that is not a snapshot");
      }
      expect(body.generation).toBe(GENERATION);
      expect(body.artists.count).toBe(2);
      expect(body.artists.rows[0].subtitle).toBe("3 Albums");
      expect(body.readAt).toBe(new Date(1_756_000_000_000).toISOString());
      expect(app.port.roots).toHaveBeenCalledWith("first-read");
    } finally {
      await app.close();
    }
  });

  it("carries no Roon key and no controller-minted id", async () => {
    const app = await serve();
    try {
      const raw = await (await fetch(`${app.url}/api/library/roots`)).text();
      expect(raw).not.toContain("itemKey");
      expect(raw).not.toContain("localId");
      expect(raw).not.toContain("item_key");
    } finally {
      await app.close();
    }
  });

  it("answers 'current' for a generation the server still holds, after checking it", async () => {
    const app = await serve();
    try {
      const response = await fetch(
        `${app.url}/api/library/roots?generation=${GENERATION}`
      );
      expect(response.status).toBe(200);
      const body = normalizeLibraryRootsResponse(await response.json());
      expect(body).toEqual({
        contract: LIBRARY_ROOTS_CONTRACT,
        kind: "current",
        generation: GENERATION,
        coreId: "core-a",
      });
      // Scope activation is one of the plan's refresh triggers: the cheap
      // check runs before the server says "still yours".
      expect(app.port.revalidate).toHaveBeenCalledWith("scope-activation");
      expect(app.port.roots).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serves the whole new snapshot when the held generation is gone", async () => {
    const fresh = snapshot("gen-2");
    const app = await serve({
      revalidate: jest.fn(async () => found(fresh)),
      roots: jest.fn(async () => found(fresh)),
    });
    try {
      const response = await fetch(
        `${app.url}/api/library/roots?generation=gen-0`
      );
      const body = normalizeLibraryRootsResponse(await response.json());
      if (body === null || body.kind !== "snapshot") {
        throw new Error("a reader holding a dead generation must get rows back");
      }
      expect(body.generation).toBe("gen-2");
      expect(app.port.roots).toHaveBeenCalledWith("scope-activation");
    } finally {
      await app.close();
    }
  });

  it("serves the new snapshot when the check itself moved the generation", async () => {
    const fresh = snapshot("gen-2");
    const app = await serve({
      revalidate: jest.fn(async () => found(fresh)),
    });
    try {
      const response = await fetch(
        `${app.url}/api/library/roots?generation=${GENERATION}`
      );
      const body = normalizeLibraryRootsResponse(await response.json());
      if (body === null || body.kind !== "snapshot") {
        throw new Error("expected rows for a generation that just died");
      }
      expect(body.generation).toBe("gen-2");
    } finally {
      await app.close();
    }
  });

  it("refuses a generation that is not one", async () => {
    const app = await serve();
    try {
      const response = await fetch(
        `${app.url}/api/library/roots?generation=${encodeURIComponent("../etc")}`
      );
      expect(response.status).toBe(400);
      expect(app.port.revalidate).not.toHaveBeenCalled();
      expect(app.port.roots).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("says why it has nothing rather than serving an empty library", async () => {
    // An empty snapshot and an unavailable Core render as the same screen if
    // the route flattens them, and one of those two is a lie.
    const app = await serve({
      current: jest.fn(() => null),
      roots: jest.fn(
        async (): Promise<LibraryRootsOutcome> => ({
          kind: "unavailable",
          reason: "core-under-pressure",
          message: "Waiting for the Roon Core to answer promptly again.",
        })
      ),
    });
    try {
      const response = await fetch(`${app.url}/api/library/roots`);
      expect(response.status).toBe(503);
      expect(
        normalizeLibraryRootsUnavailable(await response.json())
      ).toMatchObject({ reason: "core-under-pressure" });
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/library/roots/refresh", () => {
  it("re-reads on the reader's own say-so", async () => {
    const fresh = snapshot("gen-2");
    const app = await serve({
      refresh: jest.fn(async () => found(fresh)),
    });
    try {
      const response = await fetch(`${app.url}/api/library/roots/refresh`, {
        method: "POST",
      });
      const body = normalizeLibraryRootsResponse(await response.json());
      if (body === null || body.kind !== "snapshot") throw new Error("no rows");
      expect(body.generation).toBe("gen-2");
      expect(app.port.refresh).toHaveBeenCalledWith("user-refresh");
    } finally {
      await app.close();
    }
  });
});

describe("a build with no live library", () => {
  it("says so in this contract's own words rather than falling through", async () => {
    const app = express();
    app.use("/api/library", createLibraryRouter(undefined));
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/library/roots`);
      expect(response.status).toBe(503);
      expect(
        normalizeLibraryRootsUnavailable(await response.json())
      ).toMatchObject({ reason: "no-core" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("POST /api/library/open", () => {
  const REF = { generation: GENERATION, token: "library-row-a-1" };

  function level(): LibraryOpenOutcome {
    return {
      kind: "level",
      level: {
        generation: GENERATION,
        title: "Invented Artist 1",
        subtitle: "Invented credit",
        count: 2,
        rows: [
          {
            ref: { generation: GENERATION, token: "library-row-play" },
            title: "Play Artist",
            kind: "action",
          },
          {
            ref: { generation: GENERATION, token: "library-row-album" },
            title: "Invented Album A",
            subtitle: "Invented Artist 1",
            imageKey: "image-a",
            kind: "album",
          },
        ],
      },
    };
  }

  it("serves a level whose rows carry references and Roon's own text", async () => {
    const app = await serve({ open: jest.fn(async () => level()) });
    try {
      const response = await fetch(`${app.url}/api/library/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: REF }),
      });
      expect(response.status).toBe(200);
      const body = normalizeLibraryOpenResponse(await response.json());
      if (body === null || body.kind !== "level") {
        throw new Error("the route served something that is not a level");
      }
      expect(body.title).toBe("Invented Artist 1");
      expect(body.rows[1].kind).toBe("album");
      expect(body.rows[1].imageKey).toBe("image-a");
      expect(app.port.open).toHaveBeenCalledWith(REF);
    } finally {
      await app.close();
    }
  });

  it("answers 409 for a reference whose snapshot is gone", async () => {
    const stale: LibraryOpenOutcome = { kind: "stale" };
    const app = await serve({ open: jest.fn(async () => stale) });
    try {
      const response = await fetch(`${app.url}/api/library/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: REF }),
      });
      // A conflict, not a 404 and not a 503: what the reader holds has been
      // replaced, and the answer is to re-read rather than to retry.
      expect(response.status).toBe(409);
      expect(normalizeLibraryOpenResponse(await response.json())?.kind).toBe(
        "stale"
      );
    } finally {
      await app.close();
    }
  });

  it("says which unavailability it is, rather than serving an empty level", async () => {
    const app = await serve({
      open: jest.fn(
        async (): Promise<LibraryOpenOutcome> => ({
          kind: "unavailable",
          reason: "core-under-pressure",
          message: "The Roon Core is being given a rest.",
        })
      ),
    });
    try {
      const response = await fetch(`${app.url}/api/library/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: REF }),
      });
      expect(response.status).toBe(503);
      const body = normalizeLibraryOpenResponse(await response.json());
      if (body?.kind !== "unavailable") throw new Error("expected unavailable");
      expect(body.reason).toBe("core-under-pressure");
    } finally {
      await app.close();
    }
  });

  it("refuses a body that is not a reference, without asking the session", async () => {
    const app = await serve();
    try {
      for (const body of [
        {},
        { ref: { generation: GENERATION } },
        { ref: { token: "library-row-a-1" } },
        { ref: "library-row-a-1" },
      ]) {
        const response = await fetch(`${app.url}/api/library/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      expect(app.port.open).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("opens an on-demand root by name, and refuses one that is not a root", async () => {
    const app = await serve({ openRoot: jest.fn(async () => level()) });
    try {
      const ok = await fetch(`${app.url}/api/library/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: "genres" }),
      });
      expect(ok.status).toBe(200);
      expect(app.port.openRoot).toHaveBeenCalledWith(
        "genres" satisfies LibraryOnDemandRoot
      );

      const refused = await fetch(`${app.url}/api/library/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: "artists" }),
      });
      // The two roots that are always held are not on-demand roots, and asking
      // for one here is a request this route cannot honestly answer.
      expect(refused.status).toBe(400);
      expect(app.port.openRoot).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("says so plainly in a build with no live session", async () => {
    const app = express();
    app.use(express.json({ limit: "32kb" }));
    app.use("/api/library", createLibraryRouter());
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/library/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: REF }),
      });
      expect(response.status).toBe(503);
      const body = normalizeLibraryOpenResponse(await response.json());
      if (body?.kind !== "unavailable") throw new Error("expected unavailable");
      expect(body.reason).toBe("no-core");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
