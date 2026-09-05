import type { Socket } from "socket.io";

import type { LiveLibrarySession } from "../../core/library/LiveLibrarySession";
import { LIBRARY_SESSION_RETIRED_CONTRACT } from "../../shared/libraryRootsContracts";

export interface LibraryRetirementSocketDependencies {
  readonly liveLibrary: Pick<LiveLibrarySession, "onInvalidated">;
}

export function registerLibraryRetirementSocket(
  socket: Socket,
  dependencies: LibraryRetirementSocketDependencies
): void {
  let subscriptionActive = true;
  const unsubscribe = dependencies.liveLibrary.onInvalidated((event) => {
    if (event.coreId === null) return;
    socket.emit("library-session:retired", {
      contract: LIBRARY_SESSION_RETIRED_CONTRACT,
      coreId: event.coreId,
      retired: event.retired,
      reason: event.reason,
    });
  });

  socket.on("disconnect", () => {
    if (!subscriptionActive) return;
    subscriptionActive = false;
    unsubscribe();
  });
}
