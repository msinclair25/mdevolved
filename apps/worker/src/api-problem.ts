export type ApiProblemStatus =
  400 | 401 | 403 | 404 | 409 | 413 | 426 | 429 | 500 | 503;

export class ApiProblem extends Error {
  readonly code: string;
  readonly publicMessage: string;
  readonly status: ApiProblemStatus;

  constructor(status: ApiProblemStatus, code: string, publicMessage: string) {
    super(code);
    this.name = "ApiProblem";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}
