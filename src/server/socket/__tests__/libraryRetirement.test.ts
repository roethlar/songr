import { registerLibraryRetirementSocket } from "../libraryRetirement";
import type { LibraryInvalidation } from "../../../core/library/LibrarySource";

class FakeSocket {
  public readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  public readonly emitted: unknown[][] = [];

  public on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, handler);
  }

  public emit(...args: unknown[]): void {
    this.emitted.push(args);
  }

  public trigger(event: string): unknown {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`missing handler ${event}`);
    return handler();
  }
}

describe("library retirement socket adapter", () => {
  it("preserves each generation announcement and stops after disconnect", () => {
    const socket = new FakeSocket();
    let listener: ((event: LibraryInvalidation) => void) | undefined;
    let active = true;
    const unsubscribe = jest.fn(() => {
      active = false;
    });
    const liveLibrary = {
      onInvalidated: jest.fn((next: (event: LibraryInvalidation) => void) => {
        listener = next;
        return unsubscribe;
      }),
    };
    const announce = (event: LibraryInvalidation) => {
      if (active) listener?.(event);
    };
    registerLibraryRetirementSocket(socket as never, { liveLibrary });

    announce({
      coreId: "core-1",
      retired: "generation-1",
      reason: "refresh",
    });
    announce({ coreId: "core-1", retired: null, reason: "connect" });
    announce({ coreId: null, retired: null, reason: "core-lost" });

    expect(socket.emitted).toEqual([
      [
        "library-session:retired",
        {
          contract: "library-session-retired-v1",
          coreId: "core-1",
          retired: "generation-1",
          reason: "refresh",
        },
      ],
      [
        "library-session:retired",
        {
          contract: "library-session-retired-v1",
          coreId: "core-1",
          retired: null,
          reason: "connect",
        },
      ],
    ]);

    socket.trigger("disconnect");
    socket.trigger("disconnect");
    announce({
      coreId: "core-1",
      retired: "generation-2",
      reason: "session-lost",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(socket.emitted).toHaveLength(2);
  });
});
