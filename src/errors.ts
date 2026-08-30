import { jsonResponse } from "./http";

export class ApiError extends Error {
  constructor(
    readonly http: number,
    readonly text: string,
  ) {
    super(text);
    this.name = "ApiError";
  }

  toResponse(): Response {
    return jsonResponse({ error: this.text }, this.http);
  }
}

export const errNotFound = () => new ApiError(404, "not found");
export const errUnauthorized = () => new ApiError(401, "unauthorized");
export const errBadRequest = (detail: string) => new ApiError(400, detail);
