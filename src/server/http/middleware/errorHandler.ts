import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import { RoonError } from '../../../core/roon/errors';
import { ErrorResponse } from '../../../shared/types';

/**
 * Express error handling middleware
 * Catches and formats all errors with appropriate status codes
 */
export const createErrorHandler = (logger: Logger) => {
  return (
    error: Error,
    req: Request,
    res: Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: NextFunction
  ): void => {
    // Log the error with context
    logger.error(
      {
        err: error,
        method: req.method,
        path: req.path,
        body: req.body,
      },
      'Request error'
    );

    // Handle RoonError instances with custom status codes
    if (error instanceof RoonError) {
      const response: ErrorResponse = {
        error: error.message,
        details: error.code,
      };
      res.status(error.statusCode).json(response);
      return;
    }

    // Handle generic errors, honoring the Express convention of a
    // status/statusCode property (body-parser sets 400/413 on malformed
    // or oversized JSON) so client errors don't surface as 500s.
    const conventionStatus =
      (error as Partial<{ status: unknown; statusCode: unknown }>).status ??
      (error as Partial<{ statusCode: unknown }>).statusCode;
    const statusCode =
      typeof conventionStatus === 'number' &&
      Number.isInteger(conventionStatus) &&
      conventionStatus >= 400 &&
      conventionStatus <= 599
        ? conventionStatus
        : 500;
    const response: ErrorResponse = {
      error: error.message || 'Internal server error',
    };
    res.status(statusCode).json(response);
  };
};
