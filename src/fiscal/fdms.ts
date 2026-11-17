/**
 * The FDMS client — one interface, two implementations (H3).
 *
 * The fiscal worker depends on this interface only, never on a specific device. A real deployment
 * uses `httpFdmsClient`, which needs credentials (endpoint, device serial, certificate). Tests and
 * the gate use `MockFdmsClient`, which can simulate a network outage and real rejections without any
 * network call.
 *
 * The three outcomes map exactly onto what the schema does with a submission:
 *   * 'sent'        — the device accepted the invoice; the response carries its signature and QR.
 *   * 'failed'      — a REAL rejection from FDMS. This counts against the 5-attempt budget.
 *   * 'unreachable' — a NETWORK outage. The row stays pending and the attempt count is NOT touched.
 */

export type FdmsOutcome = 'sent' | 'failed' | 'unreachable';

/** One submission to the fiscal device. */
export interface FdmsSubmission {
  invoiceId: string;
  invoiceNo: string;
  payload: Record<string, unknown>;
  /** How many real rejections this invoice has already had (0 for the first submission). */
  attempt: number;
}

/** What the device answered. `response` is stored on the fiscal row when sent. */
export interface FdmsResult {
  outcome: FdmsOutcome;
  response?: Record<string, unknown> | null;
  error?: string | null;
}

export interface FdmsClient {
  submit(submission: FdmsSubmission): Promise<FdmsResult>;
}

/**
 * The brief names the interface `FDMSClient` with `MockFDMS` and `RealFDMS` implementations. Those
 * are the same three objects as `FdmsClient` / `MockFdmsClient` / `httpFdmsClient`; the aliases are
 * exported so a reader can use either vocabulary without a second implementation drifting.
 */
export type FDMSClient = FdmsClient;

/**
 * A mock FDMS device. It is a real object with real state, not a test stub: it can be put into an
 * outage (every submit reports 'unreachable'), told to reject the next N submissions (real
 * rejections), told to delay every answer (so two workers really overlap), and it records every
 * invoice it actually accepted so a test can assert that no invoice was submitted twice.
 */
export class MockFdmsClient implements FdmsClient {
  /** When false, every submission reports 'unreachable' (a network outage). */
  online = true;
  /** How many of the next submissions to reject for real. */
  rejectionsRemaining = 0;
  /** Milliseconds to wait before answering, so a test can force two workers to overlap. */
  delayMs = 0;
  /** Every invoice id the device has ACCEPTED (sent). Used to prove exactly-once submission. */
  readonly accepted: string[] = [];
  /** Every submission the device has seen, in order. */
  readonly submissions: Array<{ invoiceId: string; attempt: number }> = [];

  constructor(options: { online?: boolean; rejections?: number; delayMs?: number } = {}) {
    this.online = options.online ?? true;
    this.rejectionsRemaining = options.rejections ?? 0;
    this.delayMs = options.delayMs ?? 0;
  }

  /** Simulate a network outage. */
  outage(): void {
    this.online = false;
  }

  /** Simulate the network returning. */
  restore(): void {
    this.online = true;
  }

  async submit(submission: FdmsSubmission): Promise<FdmsResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.submissions.push({ invoiceId: submission.invoiceId, attempt: submission.attempt });

    if (!this.online) {
      return { outcome: 'unreachable', error: 'connect ECONNREFUSED fdms' };
    }
    if (this.rejectionsRemaining > 0) {
      this.rejectionsRemaining -= 1;
      return { outcome: 'failed', error: 'FDMS rejected the invoice (mock)' };
    }

    this.accepted.push(submission.invoiceId);
    return {
      outcome: 'sent',
      response: {
        signature: `SIG-${submission.invoiceNo}`,
        qr_code: `QR-${submission.invoiceNo}-${submission.invoiceId.slice(0, 8)}`,
        receipt_no: submission.invoiceNo,
        accepted_at: new Date().toISOString(),
      },
      error: null,
    };
  }
}

/** The credentials a real FDMS device needs. All are read from the environment. */
export interface FdmsCredentials {
  endpoint: string;
  deviceSerial: string;
  certificate?: string;
  apiKey?: string;
}

/** Read FDMS credentials from the environment. Null when the device is not configured. */
export function fdmsCredentials(): FdmsCredentials | null {
  const endpoint = process.env.FDMS_ENDPOINT;
  const deviceSerial = process.env.FDMS_DEVICE_SERIAL;
  if (!endpoint || !deviceSerial) return null;
  return {
    endpoint,
    deviceSerial,
    ...(process.env.FDMS_CERTIFICATE ? { certificate: process.env.FDMS_CERTIFICATE } : {}),
    ...(process.env.FDMS_API_KEY ? { apiKey: process.env.FDMS_API_KEY } : {}),
  };
}

/**
 * The real FDMS client. It POSTs the payload to the configured endpoint. A transport failure is an
 * outage ('unreachable'); a non-2xx answer is a real rejection ('failed'); a 2xx answer is 'sent'.
 *
 * This implementation is NOT exercised by the gate: real ZIMRA integration and the exact wire
 * format are open items (ADR-0003, ADR-0036).
 */
export function httpFdmsClient(
  credentials: FdmsCredentials,
  fetchImpl: typeof fetch = fetch,
): FdmsClient {
  return {
    async submit(submission: FdmsSubmission): Promise<FdmsResult> {
      let response: Response;
      try {
        response = await fetchImpl(credentials.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-device-serial': credentials.deviceSerial,
            ...(credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {}),
          },
          body: JSON.stringify({
            invoice_no: submission.invoiceNo,
            ...submission.payload,
          }),
        });
      } catch (error) {
        // A transport error is an outage, not a rejection.
        return { outcome: 'unreachable', error: (error as Error).message };
      }

      const text = await response.text();
      if (!response.ok) {
        return { outcome: 'failed', error: `FDMS ${response.status}: ${text.slice(0, 500)}` };
      }
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        body = { raw: text };
      }
      return { outcome: 'sent', response: body, error: null };
    },
  };
}

/** The brief's name for the mock device (`MockFDMS`). Same class as `MockFdmsClient`. */
export const MockFDMS = MockFdmsClient;

/** The brief's name for the real HTTP device (`RealFDMS`). Same factory as `httpFdmsClient`. */
export const RealFDMS = httpFdmsClient;
