import { errorMessage } from '../util';

describe('errorMessage', () => {
  it('returns the message of an Error instance', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a string error verbatim', () => {
    expect(errorMessage('Roon error')).toBe('Roon error');
  });

  it('returns "Unknown error" for null/undefined', () => {
    expect(errorMessage(null)).toBe('Unknown error');
    expect(errorMessage(undefined)).toBe('Unknown error');
  });

  it('JSON-stringifies plain objects', () => {
    expect(errorMessage({ code: 'E1' })).toBe('{"code":"E1"}');
  });

  it('does not throw on circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => errorMessage(circular)).not.toThrow();
  });
});
