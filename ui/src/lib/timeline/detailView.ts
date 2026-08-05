import type { AlbumRef } from '@shared/timelineCatalogContracts';
import type { TimelineAlbumDetailSnapshot } from '@shared/timelineBrowseContracts';

export interface TimelineAlbumDetailViewModel {
	readonly album: AlbumRef;
	readonly detail: TimelineAlbumDetailSnapshot | null;
	readonly phase: 'loading' | 'ready' | 'resolve-required' | 'error';
	readonly message: string | null;
}
