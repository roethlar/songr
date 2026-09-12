/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "pino";

import {
  BrowseItem,
  BrowseLoadOptions,
  BrowseOptions,
  BrowsePopOptions,
  BrowseResult,
  BrowseSearchOptions,
  SearchResult,
} from "../../shared/types";
import { RoonClient } from "./RoonClient";
import { CoreUnpairedError, RoonBrowseError } from "./errors";
import { RoonLateSettlementObserver, withRoonTimeout } from "./timeout";
import {
  CLASSIC_SEARCH_EXPANSION_DEADLINE_MS,
  CLASSIC_SEARCH_MAX_CATEGORIES,
} from "../../shared/classicBrowseContracts";
import { searchTypeForToken } from "../../shared/searchTypes";
import { UNIFIED_SONG_SEARCH_RESULT_MAX } from "../../shared/unifiedSearchContracts";
import {
  repairEncoding,
  repairOptionalEncoding,
} from "../../shared/repairEncoding";

export interface CoordinatedSearchSession {
  browse(
    options: Omit<BrowseOptions, "multiSessionKey"> & { multiSessionKey?: never }
  ): Promise<BrowseResult>;
}

export interface UnifiedSongSearchPage {
  readonly page: BrowseResult;
  readonly songs: readonly SearchResult[];
}

/** Server-internal lifecycle hooks; never accepted from HTTP or Socket.IO. */
export interface BrowseCallLifecycle {
  /** Called synchronously at the exact native Roon method handoff. */
  onIssued?: () => void;
  onTimeout?: RoonLateSettlementObserver;
}

/**
 * Wrapper around RoonApiBrowse providing normalized outputs.
 *
 * The Roon Browse API exposes two methods:
 *   browse(opts, cb) — navigate the hierarchy (drill in, pop, reset)
 *   load(opts, cb)   — fetch items at the current browse level
 *
 * browse() returns list metadata (title, count, level) but NOT items.
 * A separate load() call is always required to retrieve actual items.
 * "Pop" is done via browse() with the pop_levels parameter.
 *
 * This service is request/response — it does not emit events. Socket
 * handlers return per-socket results to avoid leaking one client's browse
 * navigation into another's.
 */
export class BrowseService {
  constructor(
    private readonly roonClient: RoonClient,
    private readonly logger: Logger
  ) {}

  /**
   * Navigate the browse hierarchy and return items.
   * Internally calls Roon browse() then load() to fetch items.
   */
  public async browse(
    options: BrowseOptions,
    lifecycle?: BrowseCallLifecycle
  ): Promise<BrowseResult> {
    this.logger.debug({ options: { ...options, ...(options.input !== undefined ? { input: "[redacted]" } : {}) } }, "BrowseService browse invoked");
    const refreshAfterNavigation =
      options.refresh === true && Boolean(options.itemKey || options.popAll);
    let browseResponse = await this.invokeBrowse(
      this.mapBrowseOptions(
        refreshAfterNavigation ? { ...options, refresh: undefined } : options
      ),
      lifecycle
    );
    if (refreshAfterNavigation && browseResponse?.action === "list") {
      browseResponse = await this.invokeBrowse(
        this.mapCurrentListRefreshOptions(options),
        lifecycle
      );
    }

    const offset = BrowseService.normalizeLoadOffset(options.offset);
    const items = await this.loadItemsForList(browseResponse, { ...options, offset }, lifecycle);
    const normalized = this.buildResult(browseResponse, items, offset);

    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
        itemCount: normalized.items.length,
      },
      "BrowseService browse result"
    );
    return normalized;
  }

  /**
   * Load items at the current browse level (pagination).
   * Roon load() accepts: hierarchy, offset, count, level.
   */
  public async load(
    options: BrowseLoadOptions,
    lifecycle?: BrowseCallLifecycle
  ): Promise<BrowseResult> {
    this.logger.debug({ options }, "BrowseService load invoked");
    const loadResponse = await this.invokeLoad(
      this.mapLoadOptions(options),
      lifecycle
    );

    const normalized = this.normalizeLoadResponse(loadResponse);
    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
        itemCount: normalized.items.length,
      },
      "BrowseService load result"
    );
    return normalized;
  }

  /**
   * Pop the browse stack by the requested number of levels.
   * Implemented via Roon browse() with pop_levels parameter,
   * then load() to fetch items at the resulting level.
   */
  public async pop(
    options: BrowsePopOptions,
    lifecycle?: BrowseCallLifecycle
  ): Promise<BrowseResult> {
    this.logger.debug({ options }, "BrowseService pop invoked");
    const refreshAfterPop = options.refresh === true;
    let browseResponse = await this.invokeBrowse(
      this.mapPopOptions(
        refreshAfterPop ? { ...options, refresh: undefined } : options
      ),
      lifecycle
    );
    if (refreshAfterPop && browseResponse?.action === "list") {
      browseResponse = await this.invokeBrowse(
        this.mapCurrentListRefreshOptions(options),
        lifecycle
      );
    }

    const items = await this.loadItemsForList(browseResponse, {
      hierarchy: options.hierarchy,
      zoneId: options.zoneId,
      multiSessionKey: options.multiSessionKey,
      offset: 0,
      pageSize: options.pageSize,
    }, lifecycle);
    const normalized = this.buildResult(browseResponse, items, 0);

    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        level: normalized.level,
        count: normalized.count,
        itemCount: normalized.items.length,
      },
      "BrowseService pop result"
    );
    return normalized;
  }

  /**
   * Reset one server-owned session hierarchy without loading its root rows.
   * This is a coordinator cleanup primitive, not a client-facing endpoint.
   */
  public async reRoot(
    hierarchy: string,
    multiSessionKey: string,
    lifecycle?: BrowseCallLifecycle,
    zoneId?: string
  ): Promise<void> {
    await this.invokeBrowse(
      this.mapBrowseOptions({
        hierarchy,
        multiSessionKey,
        popAll: true,
        ...(zoneId ? { zoneId } : {}),
      }),
      lifecycle
    );
  }

  /**
   * Expand grouped Classic search results inside one coordinator-owned search
   * channel. Category rows are walked sequentially because derived session
   * names would escape the coordinator's bounded Classic generation. Returned
   * rows are semantic descriptors and must be re-resolved before use.
   */
  public async searchCoordinated(
    session: CoordinatedSearchSession,
    options: Omit<BrowseSearchOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    }
  ): Promise<SearchResult[]> {
	const expansionDeadline = Date.now() + CLASSIC_SEARCH_EXPANSION_DEADLINE_MS;
    const rootOptions = {
      hierarchy: "search",
      input: options.input,
      zoneId: options.zoneId,
      offset: options.offset,
      popAll: options.popAll ?? true,
    } satisfies Omit<BrowseOptions, "multiSessionKey">;
    let root = await session.browse(rootOptions);
    const allCategories = root.items.filter((item) => this.isSearchCategory(item));
	const categories = allCategories.slice(0, CLASSIC_SEARCH_MAX_CATEGORIES);
    const keyless = (item: SearchResult): SearchResult => {
      const descriptor = { ...item };
      delete descriptor.itemKey;
      return descriptor;
    };
    const direct = root.items
      .filter((item) => !allCategories.includes(item))
      .map((item) => keyless(this.toSearchResult(item)));
    const expanded: SearchResult[] = [];
    let firstExpansionError: unknown;
	let expansionTruncated = allCategories.length > categories.length;

    for (const category of categories) {
	  if (Date.now() >= expansionDeadline) {
		expansionTruncated = true;
		break;
	  }
      try {
        root = await session.browse(rootOptions);
		if (Date.now() >= expansionDeadline) {
		  expansionTruncated = true;
		  break;
		}
        const freshCategory = root.items.find(
          (item) =>
            item.itemKey &&
            item.hint === "list" &&
            item.title === category.title &&
            this.isSearchCategory(item)
        );
        if (!freshCategory?.itemKey) continue;
        const page = await session.browse({
          hierarchy: "search",
          itemKey: freshCategory.itemKey,
          zoneId: options.zoneId,
          pageSize: BrowseService.SEARCH_CATEGORY_PAGE,
        });
        const resultType = this.searchCategoryType(category.title);
        expanded.push(
          ...page.items.map((item) =>
            keyless({
              ...this.toSearchResult(item),
              resultType,
              categoryTitle: category.title,
              categoryTotal: page.totalCount ?? page.count,
            })
          )
        );
      } catch (error) {
        firstExpansionError ??= error;
        this.logger.warn(
          { err: error, category: category.title },
          "Coordinated search category expansion failed"
        );
      }
    }

    // Finish at a deterministic fresh search root. Since every published row
    // is keyless, no result can carry authority from an expanded category.
    await session.browse(rootOptions);
    const results = [...direct, ...expanded];
	if (results.length === 0 && allCategories.length > 0) {
	  if (firstExpansionError) {
		throw firstExpansionError instanceof Error
		  ? firstExpansionError
		  : new Error("[BrowseService] coordinated search category expansion failed");
	  }
	  throw new Error(
		expansionTruncated
		  ? "[BrowseService] coordinated search expansion was incomplete"
		  : "[BrowseService] coordinated search categories returned no content"
	  );
    }
    return results;
  }

  /**
   * Unified Library's live song search.
   *
   * Unlike the all-category Classic search above, Unified already owns
   * authoritative local artist, album, and composer indexes. This path
   * therefore performs one search-root request, drills only the Tracks
   * category, and deliberately leaves the coordinated session on that
   * result page. The caller retains the returned raw item keys on the
   * server and replaces them with opaque result IDs before publishing.
   */
  public async searchTracksCoordinated(
    session: CoordinatedSearchSession,
    options: Omit<BrowseSearchOptions, "multiSessionKey"> & {
      multiSessionKey?: never;
    }
  ): Promise<UnifiedSongSearchPage> {
    const root = await session.browse({
      hierarchy: "search",
      input: options.input,
      zoneId: options.zoneId,
      offset: options.offset,
      popAll: options.popAll ?? true,
    });
    const trackCategories = root.items.filter(
      (item) =>
        this.isSearchCategory(item) &&
        this.searchCategoryType(item.title) === "track"
    );
    if (trackCategories.length > 1) {
      throw new Error(
        "[BrowseService] unified song search returned multiple Tracks categories"
      );
    }

    if (trackCategories.length === 1) {
      const category = trackCategories[0];
      const page = await session.browse({
        hierarchy: "search",
        itemKey: category.itemKey,
        zoneId: options.zoneId,
        pageSize: UNIFIED_SONG_SEARCH_RESULT_MAX,
      });
      const songs = page.items
        .map((item) => ({
          ...this.toSearchResult(item),
          resultType: "track" as const,
          categoryTitle: category.title,
          categoryTotal: page.totalCount ?? page.count,
        }))
        .filter(
          (item) =>
            typeof item.itemKey === "string" && item.itemKey.length > 0
        )
        .slice(0, UNIFIED_SONG_SEARCH_RESULT_MAX);
      return Object.freeze({
        page,
        songs: Object.freeze(songs),
      });
    }

    // Some Core versions publish direct hits at the search root. Retain
    // only rows Roon explicitly types as tracks; unrelated direct hits stay
    // out of the song group.
    const songs = root.items
      .map((item) => this.toSearchResult(item))
      .filter(
        (item) =>
          item.resultType === "track" &&
          typeof item.itemKey === "string" &&
          item.itemKey.length > 0
      )
      .slice(0, UNIFIED_SONG_SEARCH_RESULT_MAX);
    return Object.freeze({
      page: root,
      songs: Object.freeze(songs),
    });
  }

  /** Items loaded per expanded search category. */
  private static readonly SEARCH_CATEGORY_PAGE = 50;

  /**
   * A search-top-level category row: a 'list' row whose title is a
   * known result-type bucket and whose subtitle is a "N Results"
   * count. Real content rows never combine all three.
   */
  private isSearchCategory(item: BrowseItem): boolean {
    if (item.hint !== "list" || !item.itemKey) return false;
    if (this.searchCategoryType(item.title) === "unknown") return false;
    return /^\d+\s+results?$/i.test(item.subtitle ?? "");
  }

  /** Map a category title ("Albums") to its result type ('album'). */
  private searchCategoryType(title: string): SearchResult["resultType"] {
    return this.inferSearchType({
      title,
      itemType: title,
      isLoadable: false,
      isPlayable: false,
    });
  }

  // ── Roon API Invocation ──────────────────────────────────────────────

  private getBrowseService(): any {
    const browse = this.roonClient.getBrowse();
    if (!browse) {
      this.logger.warn("Browse requested while core unpaired");
      throw new CoreUnpairedError("Browse service unavailable");
    }
    return browse;
  }

  /**
   * Call Roon's browse() endpoint.
   */
  private invokeBrowse(
    params: Record<string, unknown>,
    lifecycle?: BrowseCallLifecycle
  ): Promise<any> {
    BrowseService.assertNativeBrowseSelectors(params);
    return this.invoke("browse", params, lifecycle);
  }

  /**
   * Call Roon's load() endpoint.
   */
  private invokeLoad(
    params: Record<string, unknown>,
    lifecycle?: BrowseCallLifecycle
  ): Promise<any> {
    return this.invoke("load", params, lifecycle);
  }

  private async invoke(
    method: "browse" | "load",
    params: Record<string, unknown>,
    lifecycle?: BrowseCallLifecycle
  ): Promise<any> {
    const service = this.getBrowseService();
    this.logger.debug({ method, params: { ...params, ...(params.input !== undefined ? { input: "[redacted]" } : {}) } }, "Invoking Roon browse API");

    return withRoonTimeout(
      `browse.${method}`,
      new Promise((resolve, reject) => {
        try {
          lifecycle?.onIssued?.();
          service[method](params, (error: unknown, response: any) => {
            if (error) {
              this.logger.error({ err: error, method }, "Roon browse call failed");
              // Roon reports a refusal as a bare string ("InvalidItemKey");
              // keep it, because whether the key is dead is the whole question.
              reject(
                error instanceof Error
                  ? error
                  : typeof error === "string" && error.length > 0
                    ? new RoonBrowseError(method, error)
                    : new Error(`[BrowseService] ${method} failed`)
              );
              return;
            }

            resolve(response);
          });
        } catch (error) {
          this.logger.error({ err: error, method }, "Roon browse invocation crashed");
          reject(
            error instanceof Error
              ? error
              : new Error(`[BrowseService] ${method} invocation failed`)
          );
        }
      }),
      undefined,
      lifecycle?.onTimeout
    );
  }

  // ── Parameter Mapping ────────────────────────────────────────────────

  /**
   * Clamp a numeric input that we forward to Roon. Negative values
   * and non-finite values are coerced to `defaultValue`; values
   * above `max` are clamped to `max`. Pass `min: 0` for offsets,
   * `min: 1` for counts/levels.
   */
  private static clamp(
    value: unknown,
    { min, max, defaultValue }: { min: number; max: number; defaultValue: number }
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
    if (value < min) return min;
    if (value > max) return max;
    return Math.floor(value);
  }

  /** The loaded slice offset is independent of Roon's remembered display position. */
  private static normalizeLoadOffset(value: unknown): number {
    return BrowseService.clamp(value, {
      min: 0,
      max: BrowseService.MAX_OFFSET,
      defaultValue: 0,
    });
  }

  private static readonly MAX_OFFSET = 1_000_000;
  private static readonly MAX_COUNT = 5_000;
  private static readonly MAX_POP_LEVELS = 32;
  private static readonly NATIVE_BROWSE_SELECTORS = [
    "item_key",
    "pop_all",
    "pop_levels",
    "refresh_list",
  ] as const;

  private static assertNativeBrowseSelectors(
    params: Record<string, unknown>
  ): void {
    const populated = BrowseService.NATIVE_BROWSE_SELECTORS.filter((key) =>
      Object.prototype.hasOwnProperty.call(params, key)
    );
    if (populated.length > 1) {
      throw new Error(
        `[BrowseService] native browse selectors are mutually exclusive: ${populated.join(
          ", "
        )}`
      );
    }
  }

  private mapBrowseOptions(options: BrowseOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
    };

    if (options.zoneId) {
      params.zone_or_output_id = options.zoneId;
    }

    if (options.itemKey) {
      params.item_key = options.itemKey;
    }

    if (typeof options.input === "string") {
      params.input = options.input;
    }

    if (typeof options.setDisplayOffset === "number") {
      params.set_display_offset = BrowseService.clamp(options.setDisplayOffset, {
        min: 0,
        max: BrowseService.MAX_OFFSET,
        defaultValue: 0,
      });
    }

    if (options.refresh === true) {
      params.refresh_list = true;
    }

    if (options.multiSessionKey) {
      params.multi_session_key = options.multiSessionKey;
    }

    if (options.popAll) {
      params.pop_all = true;
    }

    return params;
  }

  private mapCurrentListRefreshOptions(
    options: Pick<
      BrowseOptions,
      "hierarchy" | "zoneId" | "multiSessionKey"
    >
  ): Record<string, unknown> {
    return this.mapBrowseOptions({
      hierarchy: options.hierarchy,
      ...(options.zoneId ? { zoneId: options.zoneId } : {}),
      ...(options.multiSessionKey
        ? { multiSessionKey: options.multiSessionKey }
        : {}),
      refresh: true,
    });
  }

  /**
   * Map load options. Roon load() accepts:
   *   hierarchy, offset, count, level, set_display_offset
   * It does NOT accept item_key (that's a browse parameter).
   */
  private mapLoadOptions(options: BrowseLoadOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
    };

    if (options.zoneId) {
      params.zone_or_output_id = options.zoneId;
    }

    params.offset = BrowseService.normalizeLoadOffset(options.offset);

    if (typeof options.count === "number" && Number.isFinite(options.count)) {
      params.count = BrowseService.clamp(options.count, {
        min: 1,
        max: BrowseService.MAX_COUNT,
        defaultValue: BrowseService.PAGE_SIZE,
      });
    }

    if (options.multiSessionKey) {
      params.multi_session_key = options.multiSessionKey;
    }

    return params;
  }

  /**
   * Map pop options. Pop is done via browse() with pop_levels.
   */
  private mapPopOptions(options: BrowsePopOptions): Record<string, unknown> {
    const params: Record<string, unknown> = {
      hierarchy: options.hierarchy,
    };

    if (options.zoneId) {
      params.zone_or_output_id = options.zoneId;
    }

    params.pop_levels = BrowseService.clamp(options.levels, {
      min: 1,
      max: BrowseService.MAX_POP_LEVELS,
      defaultValue: 1,
    });

    if (options.refresh === true) {
      params.refresh_list = true;
    }

    if (options.multiSessionKey) {
      params.multi_session_key = options.multiSessionKey;
    }

    return params;
  }

  // ── Item Loading & Normalization ─────────────────────────────────────

  private static readonly PAGE_SIZE = 100;

  /**
   * After a browse() call, fetch items via load(). By default loads one
   * page (PAGE_SIZE items) starting from `options.offset`. Caller can
   * request a larger initial slice via `pageSize`; the value is clamped
   * to `MAX_COUNT` so a hostile or buggy client can't ask the backend
   * to chain many sequential load() roundtrips on a huge list. Larger
   * lists should be paged via `BrowseService.load()` from the client.
   *
   * `Infinity` is accepted historically (some tests + the original
   * "load everything" intent) but treated identically — clamped to
   * `MAX_COUNT`.
   */
  private async loadItemsForList(
    browseResponse: any,
    options: Pick<BrowseOptions, "hierarchy" | "zoneId" | "offset" | "multiSessionKey" | "pageSize">,
    lifecycle?: BrowseCallLifecycle
  ): Promise<any[]> {
    if (browseResponse?.action !== "list") {
      return [];
    }

    const count = browseResponse?.list?.count ?? 0;
    if (count === 0) {
      return [];
    }

    const totalCount = count;
    const startOffset = BrowseService.normalizeLoadOffset(options.offset);

    // Compute requested page size, then clamp so a single browse call
    // can't chain unbounded sequential load() calls.
    const rawRequested =
      options.pageSize === Infinity
        ? totalCount
        : typeof options.pageSize === "number" && options.pageSize > 0
          ? Math.floor(options.pageSize)
          : BrowseService.PAGE_SIZE;
    const requestedPage = Math.min(rawRequested, BrowseService.MAX_COUNT);
    const targetEnd = Math.min(totalCount, startOffset + requestedPage);

    this.logger.debug(
      {
        hierarchy: options.hierarchy,
        totalCount,
        startOffset,
        targetEnd,
        multiSessionKey: options.multiSessionKey,
      },
      "Loading items for browse result"
    );

    const batchSize = BrowseService.PAGE_SIZE;
    const allItems: any[] = [];

    for (let off = startOffset; off < targetEnd; off += batchSize) {
      const requestCount = Math.min(batchSize, targetEnd - off);
      const loadResponse = await this.invokeLoad(
        this.mapLoadOptions({
          hierarchy: options.hierarchy,
          zoneId: options.zoneId,
          offset: off,
          count: requestCount,
          multiSessionKey: options.multiSessionKey,
        }),
        lifecycle
      );
      const batch = loadResponse?.items ?? [];
      allItems.push(...batch);
      if (batch.length < requestCount) break;
    }

    return allItems;
  }

  /**
   * Build a BrowseResult from a browse() response + loaded items.
   */
  private buildResult(browseResponse: any, rawItems: any[], offset: number): BrowseResult {
    const list = browseResponse?.list ?? {};
    const normalizedItems = rawItems.map((item: any) => this.toBrowseItem(item));

    return {
      ...this.responseMessage(browseResponse),
      ...(typeof list.hint === "string" ? { listHint: list.hint } : {}),
      title: repairOptionalEncoding(list.title ?? browseResponse?.title),
      subtitle: repairOptionalEncoding(list.subtitle ?? undefined),
      level: this.ensureNumber(list.level, 0),
      offset,
      count: this.ensureNumber(list.count ?? normalizedItems.length, normalizedItems.length),
      totalCount: this.ensureOptionalNumber(list.count),
      items: normalizedItems,
    };
  }

  /**
   * Normalize a Roon load() response into a BrowseResult.
   * load() returns: { items: Item[], offset: number, list: List }
   */
  private normalizeLoadResponse(payload: any): BrowseResult {
    const list = payload?.list ?? {};
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const normalizedItems = rawItems.map((item: any) => this.toBrowseItem(item));

    return {
      ...this.responseMessage(payload),
      ...(typeof list.hint === "string" ? { listHint: list.hint } : {}),
      title: repairOptionalEncoding(list.title),
      level: this.ensureNumber(list.level, 0),
      offset: this.ensureNumber(payload?.offset ?? 0, 0),
      count: this.ensureNumber(list.count ?? normalizedItems.length, normalizedItems.length),
      totalCount: this.ensureOptionalNumber(list.count),
      items: normalizedItems,
    };
  }

  /** Preserve Roon's public action/message/is_error response separately from
   * callback failures, which continue to reject through invokeBrowse/invokeLoad.
   */
  private responseMessage(payload: any): Pick<BrowseResult, "action" | "message" | "isError"> {
    return {
      ...(typeof payload?.action === "string" ? { action: payload.action } : {}),
      ...(typeof payload?.message === "string" ? { message: repairEncoding(payload.message) } : {}),
      ...(typeof payload?.is_error === "boolean" ? { isError: payload.is_error } : {}),
    };
  }

  private toBrowseItem(item: any): BrowseItem {
    // Every display string is repaired here — the one boundary browse,
    // coordinated search, and live-library reads all flow through. The
    // live Core delivers UTF-8-as-CP1252 mojibake in some tags.
    return {
      title: repairEncoding(item?.title ?? ""),
      subtitle: repairOptionalEncoding(item?.subtitle ?? undefined),
      itemKey: item?.item_key ?? undefined,
      hint: item?.hint ?? item?.type ?? undefined,
      imageKey: item?.image_key ?? undefined,
      isLoadable: Boolean(item?.hint === "list" || item?.hint === "action_list"),
      isPlayable: Boolean(item?.hint === "action"),
      itemType: item?.item_type ?? item?.item_subtype ?? undefined,
      inputPrompt:
        typeof item?.input_prompt?.prompt === "string"
          ? repairEncoding(item.input_prompt.prompt)
          : undefined,
      inputPromptAction: typeof item?.input_prompt?.action === "string"
        ? repairEncoding(item.input_prompt.action) : undefined,
      inputPromptValue: typeof item?.input_prompt?.value === "string"
        ? item.input_prompt.value : undefined,
      inputPromptIsPassword: typeof item?.input_prompt?.is_password === "boolean"
        ? item.input_prompt.is_password : undefined,
    };
  }

  private toSearchResult(item: BrowseItem): SearchResult {
    return {
      ...item,
      resultType: this.inferSearchType(item),
    };
  }

  private inferSearchType(item: BrowseItem): SearchResult["resultType"] {
    // Prefer itemType (semantic — e.g. "album", "artist") over hint
    // (structural — e.g. "list", "action_list"). Roon search results almost
    // always carry both; falling back to hint only matters for unusual items.
    const type = (item.itemType ?? "").toLowerCase();
    const hint = (item.hint ?? "").toLowerCase();
    return searchTypeForToken(type || hint);
  }

  private ensureNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : fallback;
  }

  private ensureOptionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }
}
