/** The one HTTP function the integrations use; tests inject a fake. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: Fetch = (input, init) => fetch(input, init);

export class IntegrationError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IntegrationError";
    this.status = status;
  }
}

export async function expectOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) throw new IntegrationError(`${what} failed with HTTP ${response.status}`, response.status);
  return response;
}
