import { POST as relayPrint } from '@/app/api/printer/relay/route';

/**
 * POST /api/branch/print — the H4 path for the branch LAN relay.
 *
 * F7 moved the canonical relay to /api/printer/relay (the brief's name). This path keeps working by
 * delegating there, so a till, a bookmark or an integration that still posts here is unaffected.
 */
export async function POST(request: Request) {
  return relayPrint(request);
}
