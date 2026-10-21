import { getDb, isDbOpen } from '../db/database.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { socksProxyFamily } from './socks-address.mjs'

export async function configuredIpv6Enabled() {
  return isDbOpen() && (await new SettingsRepo(getDb()).get('proxy_pool_config'))?.ipv6_enabled === true
}

export async function proxyBlockedReason(proxy, ipv6Enabled) {
  if (ipv6Enabled === undefined) ipv6Enabled = await configuredIpv6Enabled()
  return ipv6Enabled !== true && socksProxyFamily(proxy) === 6 ? 'ipv6_disabled' : null
}

export async function assertProxyAllowed(proxy) {
  const reason = (await proxyBlockedReason(proxy))
  if (reason)
    throw Object.assign(new Error('IPv6 已关闭，请在设置 → SOCKS5 开启 IPv6 代理出口'), { code: reason, status: 409 })
}
