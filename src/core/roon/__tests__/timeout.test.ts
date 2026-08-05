import { withRoonTimeout, DEFAULT_ROON_CALL_TIMEOUT_MS } from '../timeout';
import { RoonTimeoutError } from '../errors';

describe('withRoonTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes through a resolution', async () => {
    await expect(withRoonTimeout('op', Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('passes through a rejection', async () => {
    await expect(
      withRoonTimeout('op', Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
  });

  it('rejects with RoonTimeoutError when the promise never settles', async () => {
    jest.useFakeTimers();
    const pending = withRoonTimeout('stalled-op', new Promise(() => {}));
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'RoonTimeoutError',
      code: 'OPERATION_TIMEOUT',
      statusCode: 504,
      operation: 'stalled-op',
    });
    jest.advanceTimersByTime(DEFAULT_ROON_CALL_TIMEOUT_MS);
    await assertion;
  });

  it('honors a custom timeout', async () => {
    jest.useFakeTimers();
    const pending = withRoonTimeout('op', new Promise(() => {}), 1000);
    const assertion = expect(pending).rejects.toBeInstanceOf(RoonTimeoutError);
    jest.advanceTimersByTime(1000);
    await assertion;
  });

  it('does not reject after a settle even if time passes', async () => {
    jest.useFakeTimers();
    let resolveInner!: (v: string) => void;
    const inner = new Promise<string>((r) => {
      resolveInner = r;
    });
    const wrapped = withRoonTimeout('op', inner);
    resolveInner('done');
    await expect(wrapped).resolves.toBe('done');
    jest.advanceTimersByTime(DEFAULT_ROON_CALL_TIMEOUT_MS * 2);
  });

  it('reports eventual fulfillment only after the wrapper times out', async () => {
    jest.useFakeTimers();
    let resolveInner!: () => void;
    const inner = new Promise<void>((resolve) => {
      resolveInner = resolve;
    });
    const observer = jest.fn<void, [Promise<void>]>();
    const wrapped = withRoonTimeout('op', inner, 1000, observer);
    const timeoutAssertion = expect(wrapped).rejects.toBeInstanceOf(
      RoonTimeoutError
    );

    expect(observer).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    await timeoutAssertion;
    expect(observer).toHaveBeenCalledTimes(1);

    const lateSettlement = observer.mock.calls[0][0];
    let didSettle = false;
    void lateSettlement.then(() => {
      didSettle = true;
    });
    await Promise.resolve();
    expect(didSettle).toBe(false);

    resolveInner();
    await expect(lateSettlement).resolves.toBeUndefined();
    expect(didSettle).toBe(true);
  });

  it('reports an eventual rejection without creating an unhandled rejection', async () => {
    jest.useFakeTimers();
    let rejectInner!: (error: Error) => void;
    const inner = new Promise<void>((_resolve, reject) => {
      rejectInner = reject;
    });
    const observer = jest.fn<void, [Promise<void>]>();
    const wrapped = withRoonTimeout('op', inner, 1000, observer);
    const timeoutAssertion = expect(wrapped).rejects.toBeInstanceOf(
      RoonTimeoutError
    );

    jest.advanceTimersByTime(1000);
    await timeoutAssertion;
    const lateSettlement = observer.mock.calls[0][0];
    const lateAssertion = expect(lateSettlement).rejects.toThrow('late boom');

    rejectInner(new Error('late boom'));
    await lateAssertion;
  });

  it('keeps an ignored late rejection handled', async () => {
    jest.useFakeTimers();
    let rejectInner!: (error: Error) => void;
    const inner = new Promise<void>((_resolve, reject) => {
      rejectInner = reject;
    });
    const observer = jest.fn((_lateSettlement: Promise<void>) => undefined);
    const wrapped = withRoonTimeout('op', inner, 1000, observer);
    const timeoutAssertion = expect(wrapped).rejects.toBeInstanceOf(
      RoonTimeoutError
    );

    jest.advanceTimersByTime(1000);
    await timeoutAssertion;
    rejectInner(new Error('ignored late boom'));
    await Promise.resolve();
    await Promise.resolve();

    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('does not notify when the operation settles before its deadline', async () => {
    jest.useFakeTimers();
    const observer = jest.fn<void, [Promise<void>]>();
    await expect(
      withRoonTimeout('op', Promise.resolve('ok'), 1000, observer)
    ).resolves.toBe('ok');

    jest.advanceTimersByTime(1000);
    expect(observer).not.toHaveBeenCalled();
  });

  it('keeps an observer failure from changing the timeout result', async () => {
    jest.useFakeTimers();
    const wrapped = withRoonTimeout(
      'op',
      new Promise(() => {}),
      1000,
      () => {
        throw new Error('observer failed');
      }
    );
    const assertion = expect(wrapped).rejects.toMatchObject({
      name: 'RoonTimeoutError',
      operation: 'op',
    });

    jest.advanceTimersByTime(1000);
    await assertion;
  });
});
