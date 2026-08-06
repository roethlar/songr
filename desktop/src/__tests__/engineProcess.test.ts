import { asListeningMessage } from '../engineProcess';

describe('asListeningMessage (dt2-3)', () => {
  it('accepts the backend handshake shape', () => {
    expect(asListeningMessage({ type: 'listening', port: 51_981 })).toEqual({
      type: 'listening',
      port: 51_981,
    });
    expect(asListeningMessage({ type: 'listening', port: 1 })).not.toBeNull();
    expect(
      asListeningMessage({ type: 'listening', port: 65_535 }),
    ).not.toBeNull();
  });

  it('rejects ports no TCP socket can carry', () => {
    // 0 never arrives from a bound server; anything out of range would park
    // the supervisor in running on an unloadable URL.
    expect(asListeningMessage({ type: 'listening', port: 0 })).toBeNull();
    expect(asListeningMessage({ type: 'listening', port: -1 })).toBeNull();
    expect(asListeningMessage({ type: 'listening', port: 65_536 })).toBeNull();
    expect(asListeningMessage({ type: 'listening', port: 51.5 })).toBeNull();
  });

  it('rejects everything that is not the handshake', () => {
    expect(asListeningMessage(null)).toBeNull();
    expect(asListeningMessage('listening')).toBeNull();
    expect(asListeningMessage({ type: 'listening' })).toBeNull();
    expect(asListeningMessage({ type: 'ready', port: 4000 })).toBeNull();
  });
});
