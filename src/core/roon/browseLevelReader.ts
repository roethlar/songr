/**
 * Reading one complete browse level, with the pagination integrity that makes
 * "complete" mean something.
 *
 * `.agents/plans/library-walk-binding.md` Slice 8b. These rules were written
 * for `DiscographyResolver`, and Slice 8's collection drill has to apply the
 * same ones: a locator that says "unique or nothing" is only as honest as the
 * list it counted matches in. A read that silently dropped a page would report
 * `missing` for an album that is present, and a read that silently repeated one
 * would report `ambiguous` for an album that is unique. Both would be false
 * statements about the library dressed as careful ones.
 *
 * So there is one implementation and two callers, rather than two
 * implementations that agree until somebody edits one. The five rules:
 *
 * - the level's own total must be a safe, non-negative integer within bound;
 * - the level must not need more pages than the caller allowed;
 * - every page must arrive at the offset and total that were asked for, with
 *   exactly the row count that offset and total imply;
 * - every row must carry an item key, and no key may repeat within the level;
 * - the assembled rows must number exactly the total that was promised.
 *
 * Any of them failing refuses the whole read. There is no partial answer here,
 * because a partial answer is what a caller would have to guess on top of.
 *
 * The last of the five is a backstop rather than a live check, and it is worth
 * saying so plainly: because every page is checked to carry exactly the rows
 * its offset and total imply, and the loop covers every offset, the assembled
 * count equals the total by construction. No input reaches that refusal today.
 * It is kept for a future change to the paging arithmetic, and its test suite
 * says the same thing rather than manufacturing a case that defeats the other
 * checks to reach it.
 */

import type { AllowedBrowseHierarchy } from "../../shared/browseHierarchies";
import type { BrowseItem, BrowseResult } from "../../shared/types";
import type { CoordinatedBrowseSession } from "./BrowseSessionCoordinator";

export interface BrowseLevelReadOptions {
  /** The hierarchy every continuation page is loaded from. */
  readonly hierarchy: AllowedBrowseHierarchy;
  /** Name of the level, used to build the caller's own refusal messages. */
  readonly label: string;
  readonly pageSize: number;
  readonly maxRows: number;
  readonly maxPages: number;
  /** Builds the caller's error for an integrity refusal. */
  readonly refuse: (message: string) => Error;
  /**
   * Builds the caller's error when the level's total is a real number that the
   * bound will not admit. Optional: a caller without a distinct "too large"
   * outcome reports the generic refusal for that case too.
   */
  readonly tooLarge?: (total: number) => Error;
  /**
   * Called after every await, so a caller whose page has been superseded,
   * cancelled or invalidated can stop the read rather than spend the rest of
   * it on an answer nobody is waiting for. Throwing from here aborts.
   */
  readonly assertCurrent?: () => void;
}

function appendPage(
  rows: BrowseItem[],
  seenKeys: Set<string>,
  page: BrowseResult,
  expectedOffset: number,
  expectedTotal: number,
  options: BrowseLevelReadOptions
): void {
  const expectedRows = Math.min(
    options.pageSize,
    Math.max(0, expectedTotal - expectedOffset)
  );
  if (
    page.offset !== expectedOffset ||
    page.totalCount !== expectedTotal ||
    page.items.length !== expectedRows
  ) {
    throw options.refuse(`${options.label} pagination changed`);
  }
  for (const item of page.items) {
    if (
      typeof item.itemKey !== "string" ||
      item.itemKey.length === 0 ||
      seenKeys.has(item.itemKey)
    ) {
      throw options.refuse(
        `${options.label} contained a missing or duplicate row key`
      );
    }
    seenKeys.add(item.itemKey);
    rows.push(item);
  }
}

export async function readCompleteBrowseLevel(
  session: CoordinatedBrowseSession,
  first: BrowseResult,
  options: BrowseLevelReadOptions
): Promise<BrowseItem[]> {
  const total = first.totalCount;
  if (
    total === undefined ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > options.maxRows
  ) {
    if (options.tooLarge && Number.isSafeInteger(total)) {
      throw options.tooLarge(total as number);
    }
    throw options.refuse(`${options.label} reported an invalid total`);
  }
  const pages = Math.max(1, Math.ceil(total / options.pageSize));
  if (pages > options.maxPages) {
    throw options.refuse(`${options.label} exceeded its page bound`);
  }
  const rows: BrowseItem[] = [];
  const seenKeys = new Set<string>();
  appendPage(rows, seenKeys, first, 0, total, options);

  for (
    let offset = options.pageSize;
    offset < total;
    offset += options.pageSize
  ) {
    const page = await session.load({
      hierarchy: options.hierarchy,
      offset,
      count: Math.min(options.pageSize, total - offset),
    });
    options.assertCurrent?.();
    appendPage(rows, seenKeys, page, offset, total, options);
  }
  if (rows.length !== total) {
    throw options.refuse(
      `${options.label} assembled ${rows.length} of ${total} rows`
    );
  }
  return rows;
}
