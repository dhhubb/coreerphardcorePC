import { ApiError, withAuth } from '@/app/api/_lib';
import { relayEscPosBase64 } from '@/branch/printer';
import { isBranchMode } from '@/branch/config';

interface RelayBody {
  host?: string;
  port?: number;
  base64?: string;
}

/**
 * POST /api/printer/relay — relay ESC/POS bytes to a network printer on the shop LAN (F7).
 *
 * This is the brief-named path for the branch LAN relay. H4 shipped the same operation at
 * /api/branch/print; F7 adds the brief's name and points the network transport at it, while the H4
 * path keeps working by delegating here, so nothing that already printed breaks.
 *
 * The till sends the ESC/POS bytes base64-encoded in the body (a transport encoding). The BRANCH
 * decodes them and writes the raw bytes to `host:port` (default 9100). Only a branch has a printer,
 * and only a branch opens the socket (decision 16), so this returns 409 on the cloud.
 *
 * The relay target is validated: a host is required and the port must be a real port, so the route
 * cannot be turned into an arbitrary TCP client by a malformed body.
 */
export async function POST(request: Request) {
  return withAuth(request, async () => {
    if (!isBranchMode()) {
      throw new ApiError(409, 'printing is a branch-only operation');
    }

    const body = (await request.json()) as RelayBody;
    if (!body.base64 || body.base64.length === 0) {
      throw new ApiError(422, 'base64 ESC/POS bytes are required');
    }
    if (!body.host || body.host.trim() === '') {
      throw new ApiError(422, 'a printer host is required');
    }
    const port = body.port ?? 9100;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError(422, 'printer port must be between 1 and 65535');
    }

    try {
      const result = await relayEscPosBase64(body.base64, { host: body.host.trim(), port });
      return { printed: result.printed, bytes: result.bytes, host: result.host, port: result.port };
    } catch (error) {
      // A printer that is off or unreachable is a normal condition; report it so the till can fall
      // back to the browser dialog rather than failing the sale.
      throw new ApiError(502, (error as Error).message);
    }
  });
}
