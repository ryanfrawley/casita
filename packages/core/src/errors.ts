/** Base for errors thrown across module boundaries: always an Error subclass with a code. */
export class CoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}
