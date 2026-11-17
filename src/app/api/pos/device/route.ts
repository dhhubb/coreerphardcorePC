import { withAuth } from '@/app/api/_lib';
import { loadDeviceSettings, saveDeviceSettings } from '@/verticals/pos/deviceSettings';

interface DeviceBody {
  camera_enabled?: boolean;
}

function serialise(settings: { cameraEnabled: boolean }) {
  return { camera_enabled: settings.cameraEnabled };
}

/** GET /api/pos/device — the branch's device settings. Falls back to the camera being off. */
export async function GET(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const settings = await loadDeviceSettings(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
    });
    return serialise(settings);
  });
}

/** PUT /api/pos/device — save the branch's device settings (the optional camera toggle). */
export async function PUT(request: Request) {
  return withAuth(request, async ({ client, claims }) => {
    const body = (await request.json()) as DeviceBody;
    const settings = await saveDeviceSettings(client, {
      orgId: claims.orgId!,
      branchId: claims.branchIds[0]!,
      cameraEnabled: body.camera_enabled === true,
    });
    return serialise(settings);
  });
}
