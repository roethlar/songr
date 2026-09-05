import fs from "fs";
import path from "path";
import type { Logger } from "pino";

/**
 * Deletes the saved catalog store left behind by an earlier install.
 *
 * Songr used to keep its own persistent model of the library on disk — a
 * `.catalog-v1.json` snapshot per Core, plus the artist walk's staging journal
 * and checkpoints — under `CATALOG_PATH` (default `<data>/catalog`). That model
 * is gone (`.agents/plans/library-live-view.md` Slice 4): Roon is the only
 * source of truth for library structure and Songr stores nothing about the
 * library on disk.
 *
 * An upgrading install would otherwise keep several megabytes of a model
 * nothing reads, and — worse — keep it where a future reader could mistake it
 * for state. So the directory is removed once at start, and the removal is
 * logged, because deleting a user's files silently is not something a program
 * should do.
 *
 * Failure is not fatal and must not be. A read-only data directory, or a
 * permission the installer never granted, is a reason to leave the bytes and
 * say so — not a reason to refuse to start a controller that no longer depends
 * on them.
 */
export function removeRetiredCatalogStore(
  directory: string,
  logger: Logger,
  deps: {
    readonly existsSync?: typeof fs.existsSync;
    readonly rmSync?: typeof fs.rmSync;
  } = {}
): "removed" | "absent" | "failed" {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const rmSync = deps.rmSync ?? fs.rmSync;
  // A bare relative name would resolve against whatever directory the process
  // happened to start in, which is not a place anything may be deleted from.
  const resolved = path.resolve(directory);
  try {
    if (!existsSync(resolved)) return "absent";
    rmSync(resolved, { recursive: true, force: true });
    logger.info(
      { directory: resolved },
      "Removed the retired catalog store; Songr no longer keeps a library model on disk"
    );
    return "removed";
  } catch (error) {
    logger.warn(
      { err: error, directory: resolved },
      "Could not remove the retired catalog store; it is unused and may be deleted by hand"
    );
    return "failed";
  }
}
