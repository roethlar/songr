import { Request, Response, NextFunction } from 'express';
import { createErrorHandler } from '../errorHandler';
import { CoreUnpairedError } from '../../../../core/roon/errors';

const stubLogger: any = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  level: 'info',
};

function invoke(error: Error): { status: number; body: unknown } {
  const handler = createErrorHandler(stubLogger);
  const req = { method: 'POST', path: '/api/test', body: {} } as Request;
  let status = 0;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  handler(error, req, res, jest.fn() as unknown as NextFunction);
  return { status, body };
}

describe('createErrorHandler', () => {
  it('uses the RoonError statusCode and code', () => {
    const { status, body } = invoke(new CoreUnpairedError());
    expect(status).toBe(503);
    expect(body).toEqual({
      error: 'Roon core not paired',
      details: 'CORE_UNPAIRED',
    });
  });

  it('honors an Express-convention status property (body-parser style)', () => {
    const error = Object.assign(new Error('Unexpected token'), {
      status: 400,
      statusCode: 400,
    });
    expect(invoke(error).status).toBe(400);
  });

  it('honors statusCode when status is absent', () => {
    const error = Object.assign(new Error('Payload too large'), {
      statusCode: 413,
    });
    expect(invoke(error).status).toBe(413);
  });

  it('falls back to 500 for plain errors', () => {
    expect(invoke(new Error('boom')).status).toBe(500);
  });

  it('ignores out-of-range or non-numeric status values', () => {
    expect(invoke(Object.assign(new Error('x'), { status: 200 })).status).toBe(500);
    expect(invoke(Object.assign(new Error('x'), { status: 999 })).status).toBe(500);
    expect(invoke(Object.assign(new Error('x'), { status: 'abc' })).status).toBe(500);
  });
});
