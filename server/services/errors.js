// Shared typed errors for service-layer failures. Routes map these to HTTP
// status codes via instanceof checks — no regex-matching of err.message.

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotFoundError'
    this.status = 404
  }
}
