
import type { DeviceRow, Env } from "../types";
import { checkDeviceRateLimit } from "../db/repo";

function modelQuotaBucket(deviceId: string, modelId: string): string {
  return deviceId + "::model::" + modelId;
}

export async function consumeModelQuota(
  env: Env,
  device: DeviceRow,
  modelId: string,
  limits: Map<string, number>
): Promise<{ limited: boolean; limit: number }> {
  const limit = limits.get(modelId) ?? 0;
  if (limit <= 0) return { limited: false, limit: 0 };
  const allowed = await checkDeviceRateLimit(env, modelQuotaBucket(device.id, modelId), limit);
  return { limited: !allowed, limit };
}
