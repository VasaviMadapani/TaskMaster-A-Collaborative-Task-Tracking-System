export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") =>
  new ApiError(400, message, code);
export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, message, "UNAUTHORIZED");
export const forbidden = (message = "You do not have permission to perform this action") =>
  new ApiError(403, message, "FORBIDDEN");
export const notFound = (message = "Resource not found") =>
  new ApiError(404, message, "NOT_FOUND");
export const conflict = (message: string, code = "CONFLICT") =>
  new ApiError(409, message, code);
