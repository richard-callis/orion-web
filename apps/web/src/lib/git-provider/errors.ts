/** HTTP error from a git provider API, carrying the response status. */
export class GitProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GitProviderHttpError'
  }
}

export function isNotFound(e: unknown): boolean {
  return e instanceof GitProviderHttpError && e.status === 404
}
