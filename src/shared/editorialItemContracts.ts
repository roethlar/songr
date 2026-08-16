/**
 * Strict Socket.IO contracts for editorial item sessions (rich-item plan
 * §5.3/§5.4). Product language only: no native identifier, method name, or
 * protocol vocabulary crosses this file. Every normalizer takes `unknown`,
 * returns `T | null`, and fails closed on extra keys, unknown enums,
 * unbounded text, duplicate follow targets, or a broken correlation echo.
 *
 * The editorial sidecar never decides whether a rich page exists and never
 * authorizes playback, queue, favorite, Browse, or search actions: these
 * contracts carry optional page sections and browser-safe display identity
 * only.
 */

export const EDITORIAL_ID_MAX_LENGTH = 128;
export const EDITORIAL_TITLE_MAX_LENGTH = 512;
export const EDITORIAL_META_MAX_LENGTH = 2_048;
export const EDITORIAL_TEXT_MAX_LENGTH = 262_144;
export const EDITORIAL_ERROR_MAX_LENGTH = 1_024;
export const EDITORIAL_MAX_CREDITS = 500;
export const EDITORIAL_MAX_RELATIONSHIP_ROWS = 200;
export const EDITORIAL_MAX_CREDIT_GROUPS = 16;
export const EDITORIAL_MAX_RELATIONSHIP_GROUPS = 16;
export const EDITORIAL_MAX_ATTRIBUTION_ROWS = 32;
/** Core-supplied external links (Slice 7) share the attribution row shape. */
export const EDITORIAL_MAX_LINK_ROWS = 32;
/** Upper bound for a track anchor's zero-based index (plan §6 crosswalk). */
export const EDITORIAL_MAX_TRACK_INDEX = 500;

export const EDITORIAL_ITEM_KINDS = [
	"album",
	"artist",
	"track",
	"composition",
] as const;
export type EditorialItemKind = (typeof EDITORIAL_ITEM_KINDS)[number];

export const EDITORIAL_PROSE_SECTIONS = [
	"review",
	"biography",
	"classicalBiography",
	"description",
] as const;
export type EditorialProseSectionName = (typeof EDITORIAL_PROSE_SECTIONS)[number];

/** Stable failure codes (plan §7) plus the transport-level pair. */
export const EDITORIAL_FAILURE_CODES = [
	"FEATURE_UNAVAILABLE",
	"SECTION_UNSUPPORTED",
	"ITEM_NOT_FOUND",
	"ITEM_AMBIGUOUS",
	"CONTENT_EMPTY",
	"READ_TIMEOUT",
	"SESSION_LOST",
	"PROTOCOL_INCOMPATIBLE",
	"INVALID_RESPONSE",
	"INVALID_REQUEST",
	"BACKPRESSURE",
] as const;
export type EditorialFailureCode = (typeof EDITORIAL_FAILURE_CODES)[number];

/**
 * Browser-safe public anchors: reconstructible catalog identity the server
 * already owns. The track anchor binds one exact selected album and its
 * ZERO-BASED track index (plan §6: the index IS the crosswalk into the
 * settled GetAlbum graph). Later slices extend this union (retained
 * composition); nothing here is ever a native identifier.
 */
export type EditorialItemAnchor =
	| { readonly kind: "album"; readonly albumLocalId: string }
	| { readonly kind: "artist"; readonly artistLocalId: string }
	| {
			readonly kind: "track";
			readonly albumLocalId: string;
			readonly trackIndex: number;
	  };

export interface EditorialItemOpenRequest {
	readonly requestId: string;
	readonly tabId: string;
	/** The live unified page generation the session binds to. */
	readonly generation: number;
	readonly anchor: EditorialItemAnchor;
}

export type EditorialItemOpenAck =
	| {
			readonly ok: true;
			readonly data: {
				readonly requestId: string;
				readonly sessionId: string;
				/** Server clock deadline for the first ready/failed event. */
				readonly deadlineAt: number;
			};
	  }
	| {
			readonly ok: false;
			readonly code: EditorialFailureCode;
			readonly error: string;
	  };

export interface EditorialItemFollowRequest {
	readonly requestId: string;
	readonly tabId: string;
	readonly generation: number;
	readonly sessionId: string;
	/** Opaque related target minted by the owning session. */
	readonly target: string;
}

export type EditorialItemFollowAck = EditorialItemOpenAck;

export interface EditorialItemCancelRequest {
	readonly sessionId: string;
	readonly tabId: string;
}

export interface EditorialProseSection {
	readonly text: string;
	/** Provider identity text, e.g. a source name. Display-only. */
	readonly source: string;
	readonly language: string;
	readonly author?: string;
	readonly sourceUrl?: string;
}

export interface EditorialCreditRow {
	readonly role: string;
	readonly name: string;
	/** Opaque follow target for a performer page; never action authority. */
	readonly followTarget?: string;
}

export interface EditorialCreditGroup {
	readonly label: string;
	readonly credits: readonly EditorialCreditRow[];
}

export interface EditorialRelationshipRow {
	readonly title: string;
	readonly subtitle?: string;
	readonly artworkKey?: string;
	readonly followTarget?: string;
}

export interface EditorialRelationshipGroup {
	readonly label: string;
	readonly items: readonly EditorialRelationshipRow[];
}

export interface EditorialAttributionRow {
	readonly text: string;
	/** Validated external destination; http(s) only. */
	readonly url?: string;
}


/** The browser-safe editorial view (§5.4): product fields only. */
export interface EditorialItemView {
	readonly kind: EditorialItemKind;
	readonly title: string;
	readonly subtitle?: string;
	readonly artworkKey?: string;
	readonly sections: {
		readonly [Section in EditorialProseSectionName]?: EditorialProseSection;
	};
	readonly creditGroups?: readonly EditorialCreditGroup[];
	readonly relationshipGroups?: readonly EditorialRelationshipGroup[];
	readonly attribution?: readonly EditorialAttributionRow[];
	/** Core-supplied external links (Slice 7); never navigation authority. */
	readonly links?: readonly EditorialAttributionRow[];
}

export interface EditorialItemReadyEvent {
	readonly requestId: string;
	readonly sessionId: string;
	readonly view: EditorialItemView;
}

export interface EditorialItemFailedEvent {
	readonly requestId: string;
	readonly sessionId: string;
	readonly code: EditorialFailureCode;
	/** The affected section, or null when the whole read failed. */
	readonly section: EditorialProseSectionName | null;
	readonly retryable: boolean;
	readonly error: string;
}

// ---------------------------------------------------------------------------
// Foundational guards (same idiom as libraryAlbumContracts.ts).
// ---------------------------------------------------------------------------

function plainDataRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	for (const key of Reflect.ownKeys(record)) {
		if (typeof key !== "string") return null;
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
			return null;
		}
	}
	return record;
}

function hasExactKeys(
	record: Record<string, unknown>,
	keys: readonly string[]
): boolean {
	const own = Reflect.ownKeys(record);
	return (
		own.length === keys.length &&
		own.every((key) => typeof key === "string" && keys.includes(key))
	);
}

function hasOnlyKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[]
): boolean {
	const own = Reflect.ownKeys(record);
	return (
		required.every((key) => own.includes(key)) &&
		own.every(
			(key) =>
				typeof key === "string" &&
				(required.includes(key) || optional.includes(key))
		)
	);
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export function isEditorialOpaqueId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= EDITORIAL_ID_MAX_LENGTH &&
		OPAQUE_ID_PATTERN.test(value)
	);
}

function isBoundedText(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		value.trim() === value &&
		!/\p{Cc}/u.test(value)
	);
}

/** Prose keeps internal newlines; only other control characters reject. */
function isBoundedProse(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!/(?![\n\r\t])\p{Cc}/u.test(value)
	);
}

function isGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDeadline(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFailureCode(value: unknown): value is EditorialFailureCode {
	return (
		typeof value === "string" &&
		(EDITORIAL_FAILURE_CODES as readonly string[]).includes(value)
	);
}

function isHttpUrl(value: unknown): value is string {
	if (!isBoundedText(value, EDITORIAL_META_MAX_LENGTH)) return false;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function normalizeEditorialItemAnchor(
	value: unknown
): EditorialItemAnchor | null {
	try {
		const record = plainDataRecord(value);
		if (!record) return null;
		if (record.kind === "album") {
			return hasExactKeys(record, ["kind", "albumLocalId"]) &&
				isEditorialOpaqueId(record.albumLocalId)
				? { kind: "album", albumLocalId: record.albumLocalId }
				: null;
		}
		if (record.kind === "artist") {
			return hasExactKeys(record, ["kind", "artistLocalId"]) &&
				isEditorialOpaqueId(record.artistLocalId)
				? { kind: "artist", artistLocalId: record.artistLocalId }
				: null;
		}
		if (record.kind === "track") {
			return hasExactKeys(record, ["kind", "albumLocalId", "trackIndex"]) &&
				isEditorialOpaqueId(record.albumLocalId) &&
				typeof record.trackIndex === "number" &&
				Number.isSafeInteger(record.trackIndex) &&
				record.trackIndex >= 0 &&
				record.trackIndex < EDITORIAL_MAX_TRACK_INDEX
				? {
						kind: "track",
						albumLocalId: record.albumLocalId,
						trackIndex: record.trackIndex
					}
				: null;
		}
		return null;
	} catch {
		return null;
	}
}

export function normalizeEditorialItemOpenRequest(
	value: unknown
): EditorialItemOpenRequest | null {
	try {
		const record = plainDataRecord(value);
		if (!record || !hasExactKeys(record, ["requestId", "tabId", "generation", "anchor"])) {
			return null;
		}
		const anchor = normalizeEditorialItemAnchor(record.anchor);
		if (
			!anchor ||
			!isEditorialOpaqueId(record.requestId) ||
			!isEditorialOpaqueId(record.tabId) ||
			!isGeneration(record.generation)
		) {
			return null;
		}
		return {
			requestId: record.requestId,
			tabId: record.tabId,
			generation: record.generation,
			anchor,
		};
	} catch {
		return null;
	}
}

export function normalizeEditorialItemFollowRequest(
	value: unknown
): EditorialItemFollowRequest | null {
	try {
		const record = plainDataRecord(value);
		if (
			!record ||
			!hasExactKeys(record, ["requestId", "tabId", "generation", "sessionId", "target"])
		) {
			return null;
		}
		if (
			!isEditorialOpaqueId(record.requestId) ||
			!isEditorialOpaqueId(record.tabId) ||
			!isGeneration(record.generation) ||
			!isEditorialOpaqueId(record.sessionId) ||
			!isEditorialOpaqueId(record.target)
		) {
			return null;
		}
		return {
			requestId: record.requestId,
			tabId: record.tabId,
			generation: record.generation,
			sessionId: record.sessionId,
			target: record.target,
		};
	} catch {
		return null;
	}
}

export function normalizeEditorialItemCancelRequest(
	value: unknown
): EditorialItemCancelRequest | null {
	try {
		const record = plainDataRecord(value);
		if (!record || !hasExactKeys(record, ["sessionId", "tabId"])) return null;
		if (!isEditorialOpaqueId(record.sessionId) || !isEditorialOpaqueId(record.tabId)) {
			return null;
		}
		return { sessionId: record.sessionId, tabId: record.tabId };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Acks and events (client side; expected ids are pinned, never trusted).
// ---------------------------------------------------------------------------

export function normalizeEditorialItemOpenAck(
	value: unknown,
	expectedRequestId: string
): EditorialItemOpenAck | null {
	try {
		const record = plainDataRecord(value);
		if (!record) return null;
		if (record.ok === true) {
			if (!hasExactKeys(record, ["ok", "data"])) return null;
			const data = plainDataRecord(record.data);
			if (!data || !hasExactKeys(data, ["requestId", "sessionId", "deadlineAt"])) {
				return null;
			}
			if (
				data.requestId !== expectedRequestId ||
				!isEditorialOpaqueId(data.sessionId) ||
				!isDeadline(data.deadlineAt)
			) {
				return null;
			}
			return {
				ok: true,
				data: {
					requestId: expectedRequestId,
					sessionId: data.sessionId,
					deadlineAt: data.deadlineAt,
				},
			};
		}
		if (record.ok === false) {
			if (!hasExactKeys(record, ["ok", "code", "error"])) return null;
			if (
				!isFailureCode(record.code) ||
				!isBoundedText(record.error, EDITORIAL_ERROR_MAX_LENGTH)
			) {
				return null;
			}
			return { ok: false, code: record.code, error: record.error };
		}
		return null;
	} catch {
		return null;
	}
}

function normalizeProseSection(value: unknown): EditorialProseSection | null {
	const record = plainDataRecord(value);
	if (
		!record ||
		!hasOnlyKeys(record, ["text", "source", "language"], ["author", "sourceUrl"])
	) {
		return null;
	}
	if (
		!isBoundedProse(record.text, EDITORIAL_TEXT_MAX_LENGTH) ||
		!isBoundedText(record.source, EDITORIAL_META_MAX_LENGTH) ||
		!isBoundedText(record.language, EDITORIAL_META_MAX_LENGTH)
	) {
		return null;
	}
	if ("author" in record && !isBoundedText(record.author, EDITORIAL_META_MAX_LENGTH)) {
		return null;
	}
	if ("sourceUrl" in record && !isHttpUrl(record.sourceUrl)) return null;
	return {
		text: record.text,
		source: record.source,
		language: record.language,
		...("author" in record ? { author: record.author as string } : {}),
		...("sourceUrl" in record ? { sourceUrl: record.sourceUrl as string } : {}),
	};
}

function normalizeCreditGroups(
	value: unknown,
	seenTargets: Set<string>
): readonly EditorialCreditGroup[] | null {
	if (!Array.isArray(value) || value.length > EDITORIAL_MAX_CREDIT_GROUPS) {
		return null;
	}
	let totalCredits = 0;
	const groups: EditorialCreditGroup[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) return null;
		const record = plainDataRecord(value[index]);
		if (!record || !hasExactKeys(record, ["label", "credits"])) return null;
		if (!isBoundedText(record.label, EDITORIAL_META_MAX_LENGTH)) return null;
		const rawCredits = record.credits;
		if (!Array.isArray(rawCredits)) return null;
		totalCredits += rawCredits.length;
		if (totalCredits > EDITORIAL_MAX_CREDITS) return null;
		const credits: EditorialCreditRow[] = [];
		for (let position = 0; position < rawCredits.length; position++) {
			if (!(position in rawCredits)) return null;
			const row = plainDataRecord(rawCredits[position]);
			if (!row || !hasOnlyKeys(row, ["role", "name"], ["followTarget"])) return null;
			if (
				!isBoundedText(row.name, EDITORIAL_TITLE_MAX_LENGTH) ||
				typeof row.role !== "string" ||
				row.role.length > EDITORIAL_META_MAX_LENGTH
			) {
				return null;
			}
			if ("followTarget" in row) {
				if (!isEditorialOpaqueId(row.followTarget)) return null;
				if (seenTargets.has(row.followTarget)) return null;
				seenTargets.add(row.followTarget);
			}
			credits.push({
				role: row.role,
				name: row.name,
				...("followTarget" in row
					? { followTarget: row.followTarget as string }
					: {}),
			});
		}
		groups.push({ label: record.label, credits });
	}
	return groups;
}

function normalizeRelationshipGroups(
	value: unknown,
	seenTargets: Set<string>
): readonly EditorialRelationshipGroup[] | null {
	if (!Array.isArray(value) || value.length > EDITORIAL_MAX_RELATIONSHIP_GROUPS) {
		return null;
	}
	let totalRows = 0;
	const groups: EditorialRelationshipGroup[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) return null;
		const record = plainDataRecord(value[index]);
		if (!record || !hasExactKeys(record, ["label", "items"])) return null;
		if (!isBoundedText(record.label, EDITORIAL_META_MAX_LENGTH)) return null;
		const rawItems = record.items;
		if (!Array.isArray(rawItems)) return null;
		totalRows += rawItems.length;
		if (totalRows > EDITORIAL_MAX_RELATIONSHIP_ROWS) return null;
		const items: EditorialRelationshipRow[] = [];
		for (let position = 0; position < rawItems.length; position++) {
			if (!(position in rawItems)) return null;
			const row = plainDataRecord(rawItems[position]);
			if (
				!row ||
				!hasOnlyKeys(row, ["title"], ["subtitle", "artworkKey", "followTarget"])
			) {
				return null;
			}
			if (!isBoundedText(row.title, EDITORIAL_TITLE_MAX_LENGTH)) return null;
			if (
				"subtitle" in row &&
				!isBoundedText(row.subtitle, EDITORIAL_TITLE_MAX_LENGTH)
			) {
				return null;
			}
			if (
				"artworkKey" in row &&
				!isEditorialOpaqueId(row.artworkKey)
			) {
				return null;
			}
			if ("followTarget" in row) {
				if (!isEditorialOpaqueId(row.followTarget)) return null;
				if (seenTargets.has(row.followTarget)) return null;
				seenTargets.add(row.followTarget);
			}
			items.push({
				title: row.title,
				...("subtitle" in row ? { subtitle: row.subtitle as string } : {}),
				...("artworkKey" in row ? { artworkKey: row.artworkKey as string } : {}),
				...("followTarget" in row
					? { followTarget: row.followTarget as string }
					: {}),
			});
		}
		groups.push({ label: record.label, items });
	}
	return groups;
}

function normalizeAttribution(
	value: unknown
): readonly EditorialAttributionRow[] | null {
	if (!Array.isArray(value) || value.length > EDITORIAL_MAX_ATTRIBUTION_ROWS) {
		return null;
	}
	const rows: EditorialAttributionRow[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) return null;
		const record = plainDataRecord(value[index]);
		if (!record || !hasOnlyKeys(record, ["text"], ["url"])) return null;
		if (!isBoundedText(record.text, EDITORIAL_META_MAX_LENGTH)) return null;
		if ("url" in record && !isHttpUrl(record.url)) return null;
		rows.push({
			text: record.text,
			...("url" in record ? { url: record.url as string } : {}),
		});
	}
	return rows;
}

/**
 * External links are held to a stricter row shape than attribution: every
 * row must carry a validated http(s) destination — a link without one is
 * not a link.
 */
function normalizeLinks(
	value: unknown
): readonly EditorialAttributionRow[] | null {
	if (!Array.isArray(value) || value.length > EDITORIAL_MAX_LINK_ROWS) {
		return null;
	}
	const rows: EditorialAttributionRow[] = [];
	for (let index = 0; index < value.length; index++) {
		if (!(index in value)) return null;
		const record = plainDataRecord(value[index]);
		if (!record || !hasExactKeys(record, ["text", "url"])) return null;
		if (!isBoundedText(record.text, EDITORIAL_META_MAX_LENGTH)) return null;
		if (!isHttpUrl(record.url)) return null;
		rows.push({ text: record.text, url: record.url });
	}
	return rows;
}

export function normalizeEditorialItemView(
	value: unknown
): EditorialItemView | null {
	try {
		const record = plainDataRecord(value);
		if (
			!record ||
			!hasOnlyKeys(
				record,
				["kind", "title", "sections"],
				["subtitle", "artworkKey", "creditGroups", "relationshipGroups", "attribution", "links"]
			)
		) {
			return null;
		}
		if (
			typeof record.kind !== "string" ||
			!(EDITORIAL_ITEM_KINDS as readonly string[]).includes(record.kind)
		) {
			return null;
		}
		if (!isBoundedText(record.title, EDITORIAL_TITLE_MAX_LENGTH)) return null;
		if (
			"subtitle" in record &&
			!isBoundedText(record.subtitle, EDITORIAL_TITLE_MAX_LENGTH)
		) {
			return null;
		}
		if ("artworkKey" in record && !isEditorialOpaqueId(record.artworkKey)) {
			return null;
		}
		const sectionsRecord = plainDataRecord(record.sections);
		if (
			!sectionsRecord ||
			!hasOnlyKeys(sectionsRecord, [], EDITORIAL_PROSE_SECTIONS)
		) {
			return null;
		}
		const sections: {
			[Section in EditorialProseSectionName]?: EditorialProseSection;
		} = {};
		for (const name of EDITORIAL_PROSE_SECTIONS) {
			if (!(name in sectionsRecord)) continue;
			const section = normalizeProseSection(sectionsRecord[name]);
			if (!section) return null;
			sections[name] = section;
		}
		const seenTargets = new Set<string>();
		let creditGroups: readonly EditorialCreditGroup[] | undefined;
		if ("creditGroups" in record) {
			const normalized = normalizeCreditGroups(record.creditGroups, seenTargets);
			if (!normalized) return null;
			creditGroups = normalized;
		}
		let relationshipGroups: readonly EditorialRelationshipGroup[] | undefined;
		if ("relationshipGroups" in record) {
			const normalized = normalizeRelationshipGroups(
				record.relationshipGroups,
				seenTargets
			);
			if (!normalized) return null;
			relationshipGroups = normalized;
		}
		let attribution: readonly EditorialAttributionRow[] | undefined;
		if ("attribution" in record) {
			const normalized = normalizeAttribution(record.attribution);
			if (!normalized) return null;
			attribution = normalized;
		}
		let links: readonly EditorialAttributionRow[] | undefined;
		if ("links" in record) {
			const normalized = normalizeLinks(record.links);
			if (!normalized) return null;
			links = normalized;
		}
		return {
			kind: record.kind as EditorialItemKind,
			title: record.title,
			...("subtitle" in record ? { subtitle: record.subtitle as string } : {}),
			...("artworkKey" in record ? { artworkKey: record.artworkKey as string } : {}),
			sections,
			...(creditGroups !== undefined ? { creditGroups } : {}),
			...(relationshipGroups !== undefined ? { relationshipGroups } : {}),
			...(attribution !== undefined ? { attribution } : {}),
			...(links !== undefined ? { links } : {}),
		};
	} catch {
		return null;
	}
}

export interface SalvagedEditorialItemView {
	readonly view: EditorialItemView;
	/** Prose sections dropped because they alone violated the contract. */
	readonly droppedSections: readonly EditorialProseSectionName[];
	/** True when a credit/relationship/attribution family was dropped. */
	readonly droppedFamilies: boolean;
}

/**
 * Plan §7: a malformed optional section must not discard other valid
 * sections. When the strict normalizer rejects a view, this salvage keeps
 * the valid remainder: the base identity must still normalize, each prose
 * section is validated independently (invalid ones are dropped and named),
 * and an invalid credit/relationship/attribution family is dropped whole.
 * A view whose base identity itself is invalid stays null.
 */
export function salvageEditorialItemView(
	value: unknown
): SalvagedEditorialItemView | null {
	try {
		const record = plainDataRecord(value);
		if (!record) return null;
		// Structural violations stay fatal: salvage rescues per-SECTION
		// failures only, never an unrecognizable view shape.
		if (
			!hasOnlyKeys(
				record,
				["kind", "title", "sections"],
				["subtitle", "artworkKey", "creditGroups", "relationshipGroups", "attribution", "links"]
			)
		) {
			return null;
		}
		if (
			typeof record.kind !== "string" ||
			!(EDITORIAL_ITEM_KINDS as readonly string[]).includes(record.kind) ||
			!isBoundedText(record.title, EDITORIAL_TITLE_MAX_LENGTH)
		) {
			return null;
		}
		const sectionsRecord = plainDataRecord(record.sections);
		if (!sectionsRecord || !hasOnlyKeys(sectionsRecord, [], EDITORIAL_PROSE_SECTIONS)) {
			return null;
		}

		const sections: {
			[Section in EditorialProseSectionName]?: EditorialProseSection;
		} = {};
		const droppedSections: EditorialProseSectionName[] = [];
		for (const name of EDITORIAL_PROSE_SECTIONS) {
			if (!(name in sectionsRecord)) continue;
			const section = normalizeProseSection(sectionsRecord[name]);
			if (section) sections[name] = section;
			else droppedSections.push(name);
		}

		let droppedFamilies = false;
		const seenTargets = new Set<string>();
		let creditGroups: readonly EditorialCreditGroup[] | undefined;
		if ("creditGroups" in record) {
			const normalized = normalizeCreditGroups(record.creditGroups, seenTargets);
			if (normalized) creditGroups = normalized;
			else droppedFamilies = true;
		}
		let relationshipGroups: readonly EditorialRelationshipGroup[] | undefined;
		if ("relationshipGroups" in record) {
			const normalized = normalizeRelationshipGroups(
				record.relationshipGroups,
				seenTargets
			);
			if (normalized) relationshipGroups = normalized;
			else droppedFamilies = true;
		}
		let attribution: readonly EditorialAttributionRow[] | undefined;
		if ("attribution" in record) {
			const normalized = normalizeAttribution(record.attribution);
			if (normalized) attribution = normalized;
			else droppedFamilies = true;
		}
		let links: readonly EditorialAttributionRow[] | undefined;
		if ("links" in record) {
			const normalized = normalizeLinks(record.links);
			if (normalized) links = normalized;
			else droppedFamilies = true;
		}

		const view: EditorialItemView = {
			kind: record.kind as EditorialItemKind,
			title: record.title,
			...(isBoundedText(record.subtitle, EDITORIAL_TITLE_MAX_LENGTH)
				? { subtitle: record.subtitle }
				: {}),
			...(isEditorialOpaqueId(record.artworkKey)
				? { artworkKey: record.artworkKey }
				: {}),
			sections,
			...(creditGroups !== undefined ? { creditGroups } : {}),
			...(relationshipGroups !== undefined ? { relationshipGroups } : {}),
			...(attribution !== undefined ? { attribution } : {}),
			...(links !== undefined ? { links } : {}),
		};
		// The salvage output must itself satisfy the strict contract.
		const verified = normalizeEditorialItemView(view);
		if (!verified) return null;
		return { view: verified, droppedSections, droppedFamilies };
	} catch {
		return null;
	}
}

export function normalizeEditorialItemReadyEvent(
	value: unknown,
	expected: { readonly requestId: string; readonly sessionId: string }
): EditorialItemReadyEvent | null {
	try {
		const record = plainDataRecord(value);
		if (!record || !hasExactKeys(record, ["requestId", "sessionId", "view"])) {
			return null;
		}
		if (
			record.requestId !== expected.requestId ||
			record.sessionId !== expected.sessionId
		) {
			return null;
		}
		const view = normalizeEditorialItemView(record.view);
		if (!view) return null;
		return { requestId: expected.requestId, sessionId: expected.sessionId, view };
	} catch {
		return null;
	}
}

export function normalizeEditorialItemFailedEvent(
	value: unknown,
	expected: { readonly requestId: string; readonly sessionId: string }
): EditorialItemFailedEvent | null {
	try {
		const record = plainDataRecord(value);
		if (
			!record ||
			!hasExactKeys(record, [
				"requestId",
				"sessionId",
				"code",
				"section",
				"retryable",
				"error",
			])
		) {
			return null;
		}
		if (
			record.requestId !== expected.requestId ||
			record.sessionId !== expected.sessionId
		) {
			return null;
		}
		if (!isFailureCode(record.code)) return null;
		if (
			record.section !== null &&
			!(EDITORIAL_PROSE_SECTIONS as readonly string[]).includes(
				record.section as string
			)
		) {
			return null;
		}
		if (typeof record.retryable !== "boolean") return null;
		if (!isBoundedText(record.error, EDITORIAL_ERROR_MAX_LENGTH)) return null;
		return {
			requestId: expected.requestId,
			sessionId: expected.sessionId,
			code: record.code,
			section: record.section as EditorialProseSectionName | null,
			retryable: record.retryable,
			error: record.error,
		};
	} catch {
		return null;
	}
}
