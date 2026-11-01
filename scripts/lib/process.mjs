import { spawnSync } from "node:child_process";

function isMissingProcess(error) {
  return error?.code === "ESRCH" || /no such process|not found/i.test(String(error?.message ?? error ?? ""));
}

export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcess(error);
  }
}

export async function terminateProcessTree(pid, { graceMs = 5_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { delivered: false, escalated: false };

  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    return { delivered: result.status === 0, escalated: result.status === 0 };
  }

  let delivered = false;
  try {
    process.kill(-pid, "SIGTERM");
    delivered = true;
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }

  const deadline = Date.now() + graceMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!processExists(pid)) return { delivered, escalated: false };

  try {
    process.kill(-pid, "SIGKILL");
    return { delivered: true, escalated: true };
  } catch (error) {
    if (isMissingProcess(error)) return { delivered: true, escalated: false };
    throw error;
  }
}
