import type { Point, ZoneTarget } from './types';

export const INERT_ACTION_CHOICES = [
	{ id: 'synthetic-play-now', label: 'Play Now' },
	{ id: 'synthetic-add-next', label: 'Add Next' },
	{ id: 'synthetic-queue', label: 'Queue' }
] as const;

export type InertActionChoiceId = (typeof INERT_ACTION_CHOICES)[number]['id'];

export interface InertChooserState {
	open: boolean;
	albumId: string | null;
	zoneId: string | null;
	message: 'Prototype only — no command sent';
	choices: typeof INERT_ACTION_CHOICES;
}

export interface InertActionRecord {
	albumId: string;
	zoneId: string;
	choiceId: InertActionChoiceId;
	sent: false;
}

export interface InertActionSpy {
	open(albumId: string, zoneId: string): InertChooserState;
	choose(choiceId: InertActionChoiceId): InertActionRecord;
	cancel(): void;
	getState(): InertChooserState;
	getRecords(): readonly InertActionRecord[];
	reset(): void;
}

const CLOSED_STATE: InertChooserState = {
	open: false,
	albumId: null,
	zoneId: null,
	message: 'Prototype only — no command sent',
	choices: INERT_ACTION_CHOICES
};

export function createSyntheticZones(): ZoneTarget[] {
	return [
		{
			id: 'synthetic-zone-reading-room',
			name: 'Reading Room',
			rect: { x: 1224, y: 548, width: 148, height: 64 }
		},
		{
			id: 'synthetic-zone-workshop',
			name: 'Workshop',
			rect: { x: 1224, y: 630, width: 148, height: 64 }
		}
	];
}

export function hitTestZone(point: Point, zones: readonly ZoneTarget[]): ZoneTarget | null {
	for (let index = zones.length - 1; index >= 0; index -= 1) {
		const zone = zones[index];
		const { x, y, width, height } = zone.rect;
		if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) {
			return zone;
		}
	}
	return null;
}

export const hitTest = hitTestZone;

export function createInertActionSpy(): InertActionSpy {
	let state: InertChooserState = CLOSED_STATE;
	const records: InertActionRecord[] = [];

	return {
		open(albumId, zoneId) {
			if (!albumId || !zoneId) throw new TypeError('albumId and zoneId are required');
			state = { ...CLOSED_STATE, open: true, albumId, zoneId };
			return state;
		},
		choose(choiceId) {
			if (!state.open || state.albumId === null || state.zoneId === null) {
				throw new Error('No inert chooser is open');
			}
			if (!INERT_ACTION_CHOICES.some((choice) => choice.id === choiceId)) {
				throw new RangeError('Unknown inert action choice');
			}
			const record: InertActionRecord = {
				albumId: state.albumId,
				zoneId: state.zoneId,
				choiceId,
				sent: false
			};
			records.push(record);
			state = CLOSED_STATE;
			return record;
		},
		cancel() {
			state = CLOSED_STATE;
		},
		getState() {
			return state;
		},
		getRecords() {
			return [...records];
		},
		reset() {
			state = CLOSED_STATE;
			records.splice(0, records.length);
		}
	};
}
