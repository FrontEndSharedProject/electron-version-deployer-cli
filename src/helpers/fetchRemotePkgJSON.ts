import { netRequest } from "./netRequest";
import { joinRemoteUrl } from "@/utils/joinRemoteUrl";
import { EVDErrorPhaseEnum } from "@/types/EVDErrorType";

/**
 * changelog 取不到不应该阻断更新流程，失败时返回 null
 */
export function fetchRemoteChangelogJSON(
  remote_url: string,
  timeoutMs?: number
): Promise<any> {
  return netRequest({
    url: joinRemoteUrl(remote_url, "changelog.json"),
    responseType: "json",
    timeoutMs,
    phase: EVDErrorPhaseEnum.CHECK,
  }).catch(() => null);
}

export function fetchRemotePkgJSON(
  remote_url: string,
  timeoutMs?: number
): Promise<any> {
  return netRequest({
    url: joinRemoteUrl(remote_url, "package.json"),
    responseType: "json",
    timeoutMs,
    phase: EVDErrorPhaseEnum.CHECK,
  });
}
