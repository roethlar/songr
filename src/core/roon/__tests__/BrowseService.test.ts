import { BrowseService } from '../BrowseService';
import { RoonClient } from '../RoonClient';
import { Logger } from 'pino';
import { CoreUnpairedError, RoonTimeoutError } from '../errors';
import { DEFAULT_ROON_CALL_TIMEOUT_MS } from '../timeout';
import type { BrowseOptions, BrowsePopOptions } from '../../../shared/types';

// Mock RoonClient
const mockRoonClient = {
  getTransport: jest.fn(),
  getBrowse: jest.fn(),
  getImage: jest.fn(),
  getCoreInfo: jest.fn(),
  getCoreStatus: jest.fn(),
  on: jest.fn(),
  start: jest.fn(),
} as unknown as RoonClient;

// Mock Logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: 'info',
} as unknown as Logger;

describe('BrowseService', () => {
  let service: BrowseService;
  let mockBrowseApi: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBrowseApi = {
      browse: jest.fn(),
      load: jest.fn(),
    };
    (mockRoonClient.getBrowse as jest.Mock).mockReturnValue(mockBrowseApi);
    service = new BrowseService(mockRoonClient, mockLogger);
  });

  describe('Roon call timeout', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('rejects browse with RoonTimeoutError when Roon never invokes the callback', async () => {
      jest.useFakeTimers();
      mockBrowseApi.browse.mockImplementation(() => {
        // Roon Core accepts the request but never calls back.
      });

      const pending = service.browse({ hierarchy: 'browse' });
      const assertion = expect(pending).rejects.toBeInstanceOf(RoonTimeoutError);
      jest.advanceTimersByTime(DEFAULT_ROON_CALL_TIMEOUT_MS);
      await assertion;
    });

    it('threads the eventual callback settlement to a server-internal timeout observer', async () => {
      jest.useFakeTimers();
      let callback!: (error: unknown, response: unknown) => void;
      mockBrowseApi.browse.mockImplementation((_options: unknown, cb: typeof callback) => {
        callback = cb;
      });
      const observer = jest.fn<void, [Promise<void>]>();

      const pending = service.browse(
        { hierarchy: 'browse', multiSessionKey: 'server-owned' },
        { onTimeout: observer }
      );
      const assertion = expect(pending).rejects.toBeInstanceOf(RoonTimeoutError);
      jest.advanceTimersByTime(DEFAULT_ROON_CALL_TIMEOUT_MS);
      await assertion;
      expect(observer).toHaveBeenCalledTimes(1);

      const lateSettlement = observer.mock.calls[0][0];
      callback(false, { action: 'none' });
      await expect(lateSettlement).resolves.toBeUndefined();
    });

    it('observes a timeout when navigation settles but its follow-up refresh stalls', async () => {
      jest.useFakeTimers();
      let refreshCallback!: (error: unknown, response: unknown) => void;
      mockBrowseApi.browse.mockImplementation((params: Record<string, unknown>, cb: typeof refreshCallback) => {
        if (Object.prototype.hasOwnProperty.call(params, 'pop_all')) {
          cb(false, { action: 'list', list: { level: 0, count: 0 } });
          return;
        }
        refreshCallback = cb;
      });
      const observer = jest.fn<void, [Promise<void>]>();

      const pending = service.browse(
        { hierarchy: 'artists', popAll: true, refresh: true },
        { onTimeout: observer }
      );
      const assertion = expect(pending).rejects.toBeInstanceOf(RoonTimeoutError);
      await jest.advanceTimersByTimeAsync(DEFAULT_ROON_CALL_TIMEOUT_MS);
      await assertion;

      expect(observer).toHaveBeenCalledTimes(1);
      expect(mockBrowseApi.load).not.toHaveBeenCalled();
      const lateSettlement = observer.mock.calls[0][0];
      refreshCallback(false, { action: 'list', list: { level: 0, count: 0 } });
      await expect(lateSettlement).resolves.toBeUndefined();
    });
  });

  describe('native dispatch lifecycle', () => {
    it('fires onIssued exactly at the native Roon method handoff', async () => {
      const issued = jest.fn();
      mockBrowseApi.browse.mockImplementation((_options: unknown, callback: Function) => {
        expect(issued).toHaveBeenCalledTimes(1);
        callback(false, { action: 'none' });
      });

      await service.browse({ hierarchy: 'search' }, { onIssued: issued });

      expect(issued).toHaveBeenCalledTimes(1);
      expect(mockBrowseApi.browse).toHaveBeenCalledTimes(1);
    });

    it('does not report dispatch when no native Browse service exists', async () => {
      const issued = jest.fn();
      (mockRoonClient.getBrowse as jest.Mock).mockReturnValue(null);

      await expect(
        service.browse({ hierarchy: 'search' }, { onIssued: issued })
      ).rejects.toBeInstanceOf(CoreUnpairedError);
      expect(issued).not.toHaveBeenCalled();
    });
  });

  describe('server-owned session cleanup', () => {
    it('re-roots without loading rows and preserves the private session key', async () => {
      mockBrowseApi.browse.mockImplementation((_options: unknown, callback: Function) => {
        callback(false, { action: 'list', list: { level: 0, count: 10 } });
      });

      await service.reRoot('search', 'private-session', undefined, 'zone-1');

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          multi_session_key: 'private-session',
          zone_or_output_id: 'zone-1',
          pop_all: true,
        }),
        expect.any(Function)
      );
      expect(mockBrowseApi.load).not.toHaveBeenCalled();
    });
  });

  describe('encoding repair at the normalization boundary', () => {
    const mojibake = (value: string): string =>
      Buffer.from(value, 'utf8').toString('latin1');

    it('repairs mojibake in item and list display text', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: mojibake('Genres – all'), level: 1, count: 1 },
      };
      const loadResponse = {
        items: [
          {
            title: mojibake('Concerto – Fantasia'),
            subtitle: mojibake('Café Tacvba'),
            item_key: 'k1',
            hint: 'list',
          },
        ],
        offset: 0,
        list: { title: mojibake('Genres – all'), level: 1, count: 1 },
      };
      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const result = await service.browse({ hierarchy: 'browse' });

      expect(result.title).toBe('Genres – all');
      expect(result.items[0].title).toBe('Concerto – Fantasia');
      expect(result.items[0].subtitle).toBe('Café Tacvba');
    });
  });

  describe('browse', () => {
    it('should call browse then load and return normalized items', async () => {
      // Roon browse() returns list metadata (no items)
      const browseResponse = {
        action: 'list',
        list: {
          title: 'Artists',
          level: 1,
          count: 2,
        },
      };

      // Roon load() returns items at the top level
      const loadResponse = {
        items: [
          { title: 'Artist 1', item_key: 'key1', hint: 'list' },
          { title: 'Artist 2', item_key: 'key2', hint: 'list' },
        ],
        offset: 0,
        list: { title: 'Artists', level: 1, count: 2 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const options: BrowseOptions = { hierarchy: 'browse' };
      const result = await service.browse(options);

      expect(mockBrowseApi.browse).toHaveBeenCalledTimes(1);
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(1);
      expect(result.title).toBe('Artists');
      expect(result.level).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe('Artist 1');
      expect(result.items[0].itemKey).toBe('key1');
    });

    it('surfaces input_prompt on items that require user input (e.g. Library > Search)', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Library', level: 1, count: 2 },
      };
      const loadResponse = {
        items: [
          {
            title: 'Search',
            item_key: 'key-search',
            hint: 'list',
            input_prompt: { prompt: 'Search', action: 'Go' },
          },
          { title: 'Artists', item_key: 'key-artists', hint: 'list' },
        ],
        offset: 0,
        list: { title: 'Library', level: 1, count: 2 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const result = await service.browse({ hierarchy: 'browse' });

      expect(result.items[0].inputPrompt).toBe('Search');
      expect(result.items[1].inputPrompt).toBeUndefined();
    });

    it('should not call load when browse returns action other than list', async () => {
      const browseResponse = {
        action: 'message',
        message: 'Done',
        is_error: false,
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      const result = await service.browse({ hierarchy: 'browse' });

      expect(mockBrowseApi.load).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(0);
    });

    it('should not call load when list count is 0', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Empty', level: 0, count: 0 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      const result = await service.browse({ hierarchy: 'browse' });

      expect(mockBrowseApi.load).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should throw CoreUnpairedError when browse unavailable', async () => {
      (mockRoonClient.getBrowse as jest.Mock).mockReturnValue(null);

      await expect(service.browse({ hierarchy: 'browse' })).rejects.toThrow(CoreUnpairedError);
    });

    it('should reject on browse API error', async () => {
      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(new Error('Browse failed'));
      });

      await expect(service.browse({ hierarchy: 'browse' })).rejects.toThrow('Browse failed');
    });

    it('should pass item_key for drill-down navigation', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Albums', level: 2, count: 1 },
      };
      const loadResponse = {
        items: [{ title: 'Track 1', item_key: 't1', hint: 'action' }],
        offset: 0,
        list: { title: 'Albums', level: 2, count: 1 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      await service.browse({ hierarchy: 'browse', itemKey: 'album_key' });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({ item_key: 'album_key' }),
        expect.any(Function)
      );
    });

    it('sequences a root reset before refreshing without combining native selectors', async () => {
      const rootResponse = {
        action: 'list',
        list: { title: 'Stale Artists', level: 0, count: 1 },
      };
      const refreshedResponse = {
        action: 'list',
        list: { title: 'Fresh Artists', level: 0, count: 1 },
      };
      const nativeCalls: Array<Record<string, unknown>> = [];
      const nativeOrder: string[] = [];
      const issued = jest.fn();
      mockBrowseApi.browse.mockImplementation((params: Record<string, unknown>, cb: Function) => {
        const selectors = ['item_key', 'pop_all', 'pop_levels', 'refresh_list']
          .filter((key) => Object.prototype.hasOwnProperty.call(params, key));
        if (selectors.length > 1) {
          cb('InvalidRequest', {
            message: 'Only one browse selector may be populated',
          });
          return;
        }
        nativeCalls.push(params);
        nativeOrder.push(
          Object.prototype.hasOwnProperty.call(params, 'pop_all')
            ? 'pop_all'
            : 'refresh_list'
        );
        cb(false, nativeCalls.length === 1 ? rootResponse : refreshedResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: unknown, cb: Function) => {
        nativeOrder.push('load');
        cb(false, {
          items: [{ title: 'Fresh Artist', item_key: 'fresh-artist', hint: 'list' }],
          offset: 0,
          list: refreshedResponse.list,
        });
      });

      const result = await service.browse(
        {
          hierarchy: 'artists',
          multiSessionKey: 'catalog-session',
          popAll: true,
          refresh: true,
        },
        { onIssued: issued }
      );

      expect(nativeCalls).toHaveLength(2);
      expect(nativeCalls[0]).toEqual(expect.objectContaining({
        hierarchy: 'artists',
        multi_session_key: 'catalog-session',
        pop_all: true,
      }));
      expect(nativeCalls[0]).not.toHaveProperty('refresh_list');
      expect(nativeCalls[1]).toEqual(expect.objectContaining({
        hierarchy: 'artists',
        multi_session_key: 'catalog-session',
        refresh_list: true,
      }));
      expect(nativeCalls[1]).not.toHaveProperty('pop_all');
      expect(nativeOrder).toEqual(['pop_all', 'refresh_list', 'load']);
      expect(issued).toHaveBeenCalledTimes(3);
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(1);
      expect(result.title).toBe('Fresh Artists');
      expect(result.items.map((item) => item.title)).toEqual(['Fresh Artist']);
    });

    it('sequences item navigation before a current-list refresh', async () => {
      const nativeCalls: Array<Record<string, unknown>> = [];
      mockBrowseApi.browse.mockImplementation((params: Record<string, unknown>, cb: Function) => {
        nativeCalls.push(params);
        cb(false, { action: 'list', list: { level: 1, count: 0 } });
      });

      await service.browse({
        hierarchy: 'artists',
        itemKey: 'artist-key',
        refresh: true,
      });

      expect(nativeCalls).toHaveLength(2);
      expect(nativeCalls[0]).toEqual(expect.objectContaining({
        item_key: 'artist-key',
      }));
      expect(nativeCalls[0]).not.toHaveProperty('refresh_list');
      expect(nativeCalls[1]).toEqual(expect.objectContaining({
        refresh_list: true,
      }));
      expect(nativeCalls[1]).not.toHaveProperty('item_key');
    });

    it('rejects contradictory native navigation selectors before dispatch', async () => {
      mockBrowseApi.browse.mockImplementation((_params: unknown, cb: Function) => {
        cb(false, { action: 'none' });
      });

      await expect(service.browse({
        hierarchy: 'artists',
        itemKey: 'artist-key',
        popAll: true,
      })).rejects.toThrow('mutually exclusive');

      expect(mockBrowseApi.browse).not.toHaveBeenCalled();
    });

    it('should preserve zone and multi-session context when loading browse items', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Search Result', level: 1, count: 1 },
      };
      const loadResponse = {
        items: [{ title: 'Album 1', item_key: 'album1', hint: 'list' }],
        offset: 0,
        list: { title: 'Search Result', level: 1, count: 1 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      await service.browse({
        hierarchy: 'search',
        itemKey: 'album_key',
        zoneId: 'zone123',
        multiSessionKey: 'library-search',
      });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          item_key: 'album_key',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
      expect(mockBrowseApi.load).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
    });
  });

  describe('browse pagination', () => {
    it('loads only the first page (PAGE_SIZE=100) by default for large lists', async () => {
      const totalCount = 350;
      const browseResponse = {
        action: 'list',
        list: { title: 'Big', level: 1, count: totalCount },
      };
      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      // Each load() returns the requested batch; we just need to count calls.
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = Array.from({ length: params.count }, (_, i) => ({
          title: `Item ${params.offset + i}`,
          item_key: `k${params.offset + i}`,
        }));
        cb(false, { items, offset: params.offset, list: { count: totalCount, level: 1 } });
      });

      const result = await service.browse({ hierarchy: 'browse' });

      // One browse() + one load() (first page only).
      expect(mockBrowseApi.browse).toHaveBeenCalledTimes(1);
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(100);
      expect(result.totalCount).toBe(totalCount);
    });

    it('loads the entire list when pageSize is Infinity', async () => {
      const totalCount = 250;
      const browseResponse = {
        action: 'list',
        list: { title: 'Big', level: 1, count: totalCount },
      };
      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = Array.from({ length: params.count }, (_, i) => ({
          title: `Item ${params.offset + i}`,
          item_key: `k${params.offset + i}`,
        }));
        cb(false, { items, offset: params.offset, list: { count: totalCount, level: 1 } });
      });

      const result = await service.browse({ hierarchy: 'browse', pageSize: Infinity });

      // Three load() calls for 250 items at PAGE_SIZE=100.
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(3);
      expect(result.items).toHaveLength(totalCount);
    });

    it('clamps pageSize to MAX_COUNT so a single browse call cannot chain unbounded loads', async () => {
      // 10,000-item list, caller asks for pageSize=Infinity. The
      // service must cap at MAX_COUNT (5_000) — i.e. 50 page calls
      // at PAGE_SIZE=100, not 100. Without the clamp a malicious or
      // buggy client could ask the backend to chain 100+ sequential
      // load() round-trips against Roon.
      const totalCount = 10_000;
      const browseResponse = {
        action: 'list',
        list: { title: 'Huge', level: 1, count: totalCount },
      };
      mockBrowseApi.browse.mockImplementation((_p: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = Array.from({ length: params.count }, (_, i) => ({
          title: `Item ${params.offset + i}`,
          item_key: `k${params.offset + i}`,
        }));
        cb(false, { items, offset: params.offset, list: { count: totalCount, level: 1 } });
      });

      const result = await service.browse({ hierarchy: 'browse', pageSize: Infinity });

      // 5_000 items loaded in 50 pages of 100.
      expect(mockBrowseApi.load).toHaveBeenCalledTimes(50);
      expect(result.items).toHaveLength(5_000);
    });
  });

  describe('pop', () => {
    it('should call browse with pop_levels then load items', async () => {
      const browseResponse = {
        action: 'list',
        list: { title: 'Root', level: 0, count: 3 },
      };
      const loadResponse = {
        items: [
          { title: 'Item 1', item_key: 'k1', hint: 'list' },
          { title: 'Item 2', item_key: 'k2', hint: 'list' },
          { title: 'Item 3', item_key: 'k3', hint: 'list' },
        ],
        offset: 0,
        list: { title: 'Root', level: 0, count: 3 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const options: BrowsePopOptions = { hierarchy: 'browse', levels: 2 };
      const result = await service.pop(options);

      // Pop uses browse() with pop_levels, NOT a separate pop method
      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({ hierarchy: 'browse', pop_levels: 2 }),
        expect.any(Function)
      );
      expect(result.items).toHaveLength(3);
    });

    it('should default to pop_levels 1', async () => {
      const browseResponse = { action: 'list', list: { level: 0, count: 0 } };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      await service.pop({ hierarchy: 'browse' });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({ pop_levels: 1 }),
        expect.any(Function)
      );
    });

    it('should pass multi-session context when popping a browse stack', async () => {
      const browseResponse = { action: 'list', list: { level: 0, count: 0 } };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });

      await service.pop({ hierarchy: 'search', multiSessionKey: 'library-search' });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          pop_levels: 1,
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
    });

    it('omits a false refresh selector from a native pop request', async () => {
      const browseResponse = { action: 'list', list: { level: 0, count: 0 } };
      mockBrowseApi.browse.mockImplementation((_params: unknown, cb: Function) => {
        cb(false, browseResponse);
      });

      await service.pop({ hierarchy: 'artists', levels: 1, refresh: false });

      expect(mockBrowseApi.browse).toHaveBeenCalledTimes(1);
      expect(mockBrowseApi.browse.mock.calls[0][0]).toEqual(expect.objectContaining({
        hierarchy: 'artists',
        pop_levels: 1,
      }));
      expect(mockBrowseApi.browse.mock.calls[0][0]).not.toHaveProperty('refresh_list');
    });

    it('sequences a parent pop before refreshing without combining native selectors', async () => {
      const browseResponse = { action: 'list', list: { level: 0, count: 0 } };
      const nativeCalls: Array<Record<string, unknown>> = [];
      mockBrowseApi.browse.mockImplementation((params: Record<string, unknown>, cb: Function) => {
        const selectors = ['item_key', 'pop_all', 'pop_levels', 'refresh_list']
          .filter((key) => Object.prototype.hasOwnProperty.call(params, key));
        if (selectors.length > 1) {
          cb('InvalidRequest', {
            message: 'Only one browse selector may be populated',
          });
          return;
        }
        nativeCalls.push(params);
        cb(false, browseResponse);
      });

      await service.pop({
        hierarchy: 'artists',
        zoneId: 'zone-1',
        levels: 1,
        refresh: true,
        multiSessionKey: 'timeline-session',
      });

      expect(nativeCalls).toHaveLength(2);
      expect(nativeCalls[0]).toEqual(expect.objectContaining({
        hierarchy: 'artists',
        zone_or_output_id: 'zone-1',
        multi_session_key: 'timeline-session',
        pop_levels: 1,
      }));
      expect(nativeCalls[0]).not.toHaveProperty('refresh_list');
      expect(nativeCalls[1]).toEqual(expect.objectContaining({
        hierarchy: 'artists',
        zone_or_output_id: 'zone-1',
        multi_session_key: 'timeline-session',
        refresh_list: true,
      }));
      expect(nativeCalls[1]).not.toHaveProperty('pop_levels');
    });
  });

  describe('load', () => {
    it('should call load API and normalize items from top-level response', async () => {
      const loadResponse = {
        items: [
          { title: 'Item A', item_key: 'a', hint: 'list' },
        ],
        offset: 0,
        list: { title: 'Browse', level: 0, count: 5 },
      };

      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const result = await service.load({ hierarchy: 'browse', offset: 0 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Item A');
      expect(result.count).toBe(5);
    });
  });

  describe('search', () => {
    it('should return search results with inferred types', async () => {
      const browseResponse = {
        action: 'list',
        list: { level: 0, count: 2 },
      };
      const loadResponse = {
        items: [
          { title: 'Track 1', hint: 'action', item_key: 'key1' },
          { title: 'Album 1', hint: 'list', item_key: 'key2' },
        ],
        offset: 0,
        list: { level: 0, count: 2 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      const results = await service.search({ input: 'test' });

      expect(results).toHaveLength(2);
      // hint "action" doesn't match any search type category
      expect(results[0].resultType).toBe('unknown');
    });

    it('should search in the provided multi-session context', async () => {
      const browseResponse = {
        action: 'list',
        list: { level: 0, count: 1 },
      };
      const loadResponse = {
        items: [{ title: 'Album 1', hint: 'list', item_key: 'key1' }],
        offset: 0,
        list: { level: 0, count: 1 },
      };

      mockBrowseApi.browse.mockImplementation((_params: any, cb: Function) => {
        cb(false, browseResponse);
      });
      mockBrowseApi.load.mockImplementation((_params: any, cb: Function) => {
        cb(false, loadResponse);
      });

      await service.search({
        input: 'test',
        zoneId: 'zone123',
        multiSessionKey: 'library-search',
      });

      expect(mockBrowseApi.browse).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          input: 'test',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
          pop_all: true,
        }),
        expect.any(Function)
      );
      expect(mockBrowseApi.load).toHaveBeenCalledWith(
        expect.objectContaining({
          hierarchy: 'search',
          zone_or_output_id: 'zone123',
          multi_session_key: 'library-search',
        }),
        expect.any(Function)
      );
    });
  });

  describe('search category expansion', () => {
    const directRow = {
      title: 'Hamilton: An American Musical',
      subtitle: 'Lio-Marcus Mendel',
      item_key: 'direct-1',
      hint: 'list',
    };
    const tracksCategory = {
      title: 'Tracks',
      subtitle: '17 Results',
      item_key: 'cat-tracks',
      hint: 'list',
    };
    const trackRows = [
      { title: 'Hamilton: My Shot', subtitle: 'Lio-Marcus Mendel', item_key: 't1', hint: 'action_list' },
      { title: 'Harlington: Dear Thea', subtitle: 'Leslie Odom Jr.', item_key: 't2', hint: 'action_list' },
    ];

    // Route mock responses by session: the main session and each
    // category session first see the top-level search list; a browse
    // carrying item_key is the category drill, whose load returns the
    // category's items.
    function routeSearch(topItems: any[], catItems: any[], opts: { failDrill?: boolean } = {}) {
      const drilled = new Set<string>();
      mockBrowseApi.browse.mockImplementation((params: any, cb: Function) => {
        if (params.item_key) {
          if (opts.failDrill) {
            cb('drill failed');
            return;
          }
          drilled.add(params.multi_session_key);
          cb(false, { action: 'list', list: { level: 1, count: catItems.length } });
          return;
        }
        cb(false, { action: 'list', list: { level: 0, count: topItems.length } });
      });
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = drilled.has(params.multi_session_key) ? catItems : topItems;
        cb(false, { items, offset: 0, list: { level: 0, count: items.length } });
      });
    }

    it('expands category rows into typed items and drops the stubs', async () => {
      routeSearch([directRow, tracksCategory], trackRows);

      const results = await service.search({ input: 'hamilton', multiSessionKey: 'sess' });

      // The "Tracks — 17 Results" stub is consumed, not returned.
      expect(results.some((r) => r.title === 'Tracks')).toBe(false);
      // Its items come back typed by the category.
      const tracks = results.filter((r) => r.resultType === 'track');
      expect(tracks.map((t) => t.title)).toEqual([
        'Hamilton: My Shot',
        'Harlington: Dear Thea',
      ]);
      // Direct hits are preserved.
      expect(results.some((r) => r.title === 'Hamilton: An American Musical')).toBe(true);
      // The drill ran in a derived generation-stamped session, not the
      // caller's (first search on a fresh service → generation 0).
      expect(
        mockBrowseApi.browse.mock.calls.some(
          ([p]: any[]) =>
            p.multi_session_key === 'sess:cat:track:g0' && p.item_key === 'cat-tracks'
        )
      ).toBe(true);
    });

    it('quarantines a generation whose expansion failed instead of reusing it (rev-2 round 2)', async () => {
      // A timed-out/failed Roon call is uncancellable and may mutate
      // its session late; the failed search's generation must never be
      // handed to a later search.
      routeSearch([directRow, tracksCategory], trackRows, { failDrill: true });
      await service.search({ input: 'first', multiSessionKey: 'sess' });

      routeSearch([directRow, tracksCategory], trackRows);
      await service.search({ input: 'second', multiSessionKey: 'sess' });

      const secondRootKeys = mockBrowseApi.browse.mock.calls
        .filter(
          ([p]: any[]) =>
            p.input === 'second' && String(p.multi_session_key ?? '').includes(':cat:')
        )
        .map(([p]: any[]) => p.multi_session_key);
      // First search consumed g0 and failed → second must mint g1.
      expect(secondRootKeys).toEqual(['sess:cat:track:g1']);
    });

    it('fails the search instead of returning a false empty when expansion failure lost every result (rev-3)', async () => {
      // The top level holds ONLY the category stub, and its drill
      // fails: a plain [] here would render as "No results — check
      // the spelling" for content the library may well contain, so
      // the failure must propagate to the caller.
      routeSearch([tracksCategory], trackRows, { failDrill: true });

      await expect(
        service.search({ input: 'hamilton', multiSessionKey: 'sess' })
      ).rejects.toThrow('browse failed');
    });

    it('still tolerates a failed category while other results survive (rev-3)', async () => {
      // The complementary isolation invariant: one broken category
      // must not sink a search that produced anything else.
      routeSearch([directRow, tracksCategory], trackRows, { failDrill: true });

      const results = await service.search({ input: 'hamilton', multiSessionKey: 'sess' });

      expect(results.map((r) => r.title)).toEqual(['Hamilton: An American Musical']);
    });

    it('a slow in-flight search keeps its category session while many searches run (rev-2)', async () => {
      // Reviewer reopen scenario: search A blocks in its category
      // drill-load while several quick searches complete. With a fixed
      // rotation the counter wraps, a later search re-seeds A's
      // session, and A returns the OTHER query's items. The
      // lifetime-held generation pool must keep A isolated no matter
      // how many searches run meanwhile.
      const rowsFor = (q: string) => [
        { title: `${q}-Track`, subtitle: q, item_key: `t-${q}`, hint: 'action_list' },
      ];
      let releaseA!: () => void;
      const gateA = new Promise<void>((r) => (releaseA = r));
      const drilled = new Set<string>();
      // Which query most recently seeded each category session — a
      // collision overwrites the owner, exactly like Roon's session
      // state would.
      const sessionQuery = new Map<string, string>();

      mockBrowseApi.browse.mockImplementation((params: any, cb: Function) => {
        const key = params.multi_session_key ?? '';
        if (key.includes(':cat:') && params.input) sessionQuery.set(key, params.input);
        // A root (pop_all) browse resets the session, like Roon's does;
        // a drill moves it a level deep.
        if (params.item_key) {
          drilled.add(key);
        } else {
          drilled.delete(key);
        }
        cb(false, { action: 'list', list: { level: params.item_key ? 1 : 0, count: 1 } });
      });
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const key = params.multi_session_key ?? '';
        if (!drilled.has(key)) {
          cb(false, { items: [tracksCategory], offset: 0, list: { level: 0, count: 1 } });
          return;
        }
        // The session owner is resolved when the load COMPLETES, not
        // when it is issued — a collision that re-seeds the session
        // while a slow load is pending changes what comes back, same
        // as the real Core.
        const respond = () => {
          const owner = sessionQuery.get(key) ?? 'unseeded';
          cb(false, { items: rowsFor(owner), offset: 0, list: { level: 1, count: 1 } });
        };
        if ((sessionQuery.get(key) ?? '') === 'query-a') {
          void gateA.then(respond);
        } else {
          respond();
        }
      });

      const pendingA = service.search({ input: 'query-a', multiSessionKey: 'sess' });
      // Let A reach its gated category load.
      await new Promise((r) => setTimeout(r, 0));

      // Enough quick searches to wrap any small fixed rotation.
      for (const q of ['query-b', 'query-c', 'query-d', 'query-e', 'query-f']) {
        const result = await service.search({ input: q, multiSessionKey: 'sess' });
        expect(result.filter((x) => x.resultType === 'track').map((x) => x.title)).toEqual([
          `${q}-Track`,
        ]);
      }

      releaseA();
      const a = await pendingA;
      expect(a.filter((x) => x.resultType === 'track').map((x) => x.title)).toEqual([
        'query-a-Track',
      ]);
    });

    it('stamps expanded items with the category title and Roon total (rev-4)', async () => {
      const drilled = new Set<string>();
      mockBrowseApi.browse.mockImplementation((params: any, cb: Function) => {
        if (params.item_key) {
          drilled.add(params.multi_session_key);
          // Roon reports 80 matches; only one page is loaded.
          cb(false, { action: 'list', list: { level: 1, count: 80 } });
          return;
        }
        cb(false, { action: 'list', list: { level: 0, count: 1 } });
      });
      mockBrowseApi.load.mockImplementation((params: any, cb: Function) => {
        const items = drilled.has(params.multi_session_key)
          ? trackRows
          : [tracksCategory];
        cb(false, { items, offset: 0, list: { level: 0, count: items.length } });
      });

      const results = await service.search({ input: 'hamilton', multiSessionKey: 'sess' });

      const tracks = results.filter((r) => r.resultType === 'track');
      expect(tracks.length).toBeGreaterThan(0);
      for (const t of tracks) {
        expect(t.categoryTitle).toBe('Tracks');
        expect(t.categoryTotal).toBe(80);
      }
    });

    it('keeps direct results when a category drill fails', async () => {
      routeSearch([directRow, tracksCategory], trackRows, { failDrill: true });

      const results = await service.search({ input: 'hamilton', multiSessionKey: 'sess' });

      expect(results.some((r) => r.title === 'Hamilton: An American Musical')).toBe(true);
      expect(results.filter((r) => r.resultType === 'track')).toHaveLength(0);
    });

    it('does not treat a content row titled like a category as a category', async () => {
      // An album named "Tracks" with an artist subtitle must stay a
      // direct result — only "N Results" subtitles mark categories.
      const decoy = { title: 'Tracks', subtitle: 'Some Artist', item_key: 'a1', hint: 'list' };
      routeSearch([decoy], []);

      const results = await service.search({ input: 'tracks', multiSessionKey: 'sess' });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Tracks');
      expect(
        mockBrowseApi.browse.mock.calls.some(([p]: any[]) =>
          String(p.multi_session_key ?? '').includes(':cat:')
        )
      ).toBe(false);
    });

    it('expands a coordinated search sequentially in one keyless role and finishes at root', async () => {
      const root = {
        title: 'Search',
        level: 0,
        count: 2,
        items: [
          {
            title: directRow.title,
            subtitle: directRow.subtitle,
            itemKey: directRow.item_key,
            hint: directRow.hint,
          },
          {
            title: tracksCategory.title,
            subtitle: tracksCategory.subtitle,
            itemKey: tracksCategory.item_key,
            hint: tracksCategory.hint,
          },
        ],
      };
      const page = {
        title: 'Tracks',
        level: 1,
        count: 2,
        totalCount: 17,
        items: trackRows.map((item) => ({
          title: item.title,
          subtitle: item.subtitle,
          itemKey: item.item_key,
          hint: item.hint,
        })),
      };
      const browse = jest
        .fn()
        .mockResolvedValueOnce(root)
        .mockResolvedValueOnce(root)
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce(root);

      const results = await service.searchCoordinated(
        { browse },
        { input: 'hamilton', zoneId: 'zone-1' }
      );

      expect(browse).toHaveBeenCalledTimes(4);
      expect(browse.mock.calls[browse.mock.calls.length - 1]?.[0]).toMatchObject({
        hierarchy: 'search',
        input: 'hamilton',
        popAll: true,
      });
      expect(results.map((result) => result.title)).toEqual([
        directRow.title,
        ...trackRows.map((row) => row.title),
      ]);
      expect(results.every((result) => result.itemKey === undefined)).toBe(true);
      expect(JSON.stringify(browse.mock.calls)).not.toContain('multiSessionKey');
    });

    it('represents all eight fast taxonomy categories without publishing category stubs', async () => {
      const categoryTitles = [
        'Artists',
        'Albums',
        'Tracks',
        'Playlists',
        'Genres',
        'Composers',
        'Labels',
        'Stations',
      ];
      const categories = categoryTitles.map((title, index) => ({
        title,
        subtitle: '1 Result',
        itemKey: `category-${index}`,
        hint: 'list',
        isLoadable: false,
        isPlayable: false,
      }));
      const root = { title: 'Search', level: 0, offset: 0, count: 8, items: categories };
      const browse = jest.fn(async (options) => {
        if (options.popAll) return root;
        const index = Number(String(options.itemKey).split('-')[1]);
        return {
          title: categoryTitles[index],
          level: 1,
          offset: 0,
          count: 1,
          items: [{
            title: `Result ${index}`,
            itemKey: `result-${index}`,
            hint: 'action_list',
            isLoadable: false,
            isPlayable: true,
          }],
        };
      });

      const results = await service.searchCoordinated(
        { browse },
        { input: 'all types' }
      );

      expect(results).toHaveLength(8);
      expect(results.map((result) => result.title)).toEqual(
        categoryTitles.map((_title, index) => `Result ${index}`)
      );
      expect(results.some((result) => categoryTitles.includes(result.title))).toBe(false);
      expect(results.every((result) => result.itemKey === undefined)).toBe(true);
    });

    it('caps malformed roots with more than eight recognized category rows', async () => {
      const titles = [
        'Artists',
        'Albums',
        'Tracks',
        'Playlists',
        'Genres',
        'Composers',
        'Labels',
        'Stations',
        'Tracks',
      ];
      const root = {
        title: 'Search',
        level: 0,
        offset: 0,
        count: titles.length,
        items: titles.map((title, index) => ({
          title,
          subtitle: '1 Result',
          itemKey: `category-${index}`,
          hint: 'list',
          isLoadable: false,
          isPlayable: false,
        })),
      };
      let expansion = 0;
      const browse = jest.fn(async (options) => {
        if (options.popAll) return root;
        expansion += 1;
        return {
          title: 'Expanded',
          level: 1,
          offset: 0,
          count: 1,
          items: [{
            title: `Content ${expansion}`,
            itemKey: `raw-content-${expansion}`,
            hint: 'action_list',
            isLoadable: false,
            isPlayable: true,
          }],
        };
      });

      const results = await service.searchCoordinated({ browse }, { input: 'malformed' });

      expect(expansion).toBe(8);
      expect(results).toHaveLength(8);
      expect(results.every((result) => result.itemKey === undefined)).toBe(true);
      expect(results.some((result) => titles.includes(result.title))).toBe(false);
    });

    it('throws instead of reporting false-empty when the expansion deadline truncates categories', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(45_000);
      const root = {
        title: 'Search',
        level: 0,
        offset: 0,
        count: 1,
        items: [{
          title: 'Tracks',
          subtitle: '1 Result',
          itemKey: 'tracks-category',
          hint: 'list',
          isLoadable: false,
          isPlayable: false,
        }],
      };
      const browse = jest.fn().mockResolvedValue(root);

      await expect(
        service.searchCoordinated({ browse }, { input: 'deadline' })
      ).rejects.toThrow('incomplete');
      expect(browse).toHaveBeenCalledTimes(2);
      now.mockRestore();
    });

    it('runs one root search and one Tracks drill while retaining raw song keys server-side', async () => {
      const root = {
        title: 'Search',
        level: 0,
        offset: 0,
        count: 3,
        items: [
          {
            title: 'Artists',
            subtitle: '1 Result',
            itemKey: 'artists-category',
            hint: 'list',
            isLoadable: false,
            isPlayable: false,
          },
          {
            title: 'Tracks',
            subtitle: '2 Results',
            itemKey: 'tracks-category',
            hint: 'list',
            isLoadable: false,
            isPlayable: false,
          },
          {
            title: 'Albums',
            subtitle: '1 Result',
            itemKey: 'albums-category',
            hint: 'list',
            isLoadable: false,
            isPlayable: false,
          },
        ],
      };
      const tracks = {
        title: 'Tracks',
        level: 1,
        offset: 0,
        count: 2,
        totalCount: 2,
        items: [
          {
            title: 'Dear Theodosia',
            subtitle: 'Orlando Ballet Chorus',
            itemKey: 'raw-song-1',
            hint: 'action_list',
            isLoadable: false,
            isPlayable: true,
          },
          {
            title: 'Dear Theodosia (Reprise)',
            subtitle: 'Orlando Ballet Chorus',
            itemKey: 'raw-song-2',
            hint: 'action_list',
            isLoadable: false,
            isPlayable: true,
          },
        ],
      };
      const browse = jest
        .fn()
        .mockResolvedValueOnce(root)
        .mockResolvedValueOnce(tracks);

      const results = await service.searchTracksCoordinated(
        { browse },
        { input: 'dear theodosia' }
      );

      expect(browse).toHaveBeenCalledTimes(2);
      expect(browse.mock.calls[0][0]).toMatchObject({
        hierarchy: 'search',
        input: 'dear theodosia',
        popAll: true,
      });
      expect(browse.mock.calls[1][0]).toMatchObject({
        hierarchy: 'search',
        itemKey: 'tracks-category',
      });
      expect(results.page).toBe(tracks);
      expect(results.songs.map((result) => result.itemKey)).toEqual([
        'raw-song-1',
        'raw-song-2',
      ]);
      expect(results.songs.every((result) => result.resultType === 'track')).toBe(true);
    });
  });
});
