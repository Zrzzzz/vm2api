/**
 * Tenant ownership for VMs, proxies, and /v1 dispatch.
 * vm.json is SSOT for VM owner/origin; this module is the only decoder.
 */

export const VM_ORIGIN = {
  platform: 'platform',
  adminAssigned: 'admin_assigned',
  userCreated: 'user_created',
}

export const PLATFORM_SCOPE: Readonly<{ type: 'platform' }> = Object.freeze({ type: 'platform' })

export function normalizeOwnerId(id: unknown) {
  const s = String(id || '').trim()
  return s || null
}

export function clampVmCreateQuota(value: unknown, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, Math.round(n)))
}

export function vmOwnerId(vm: OwnedResource | null | undefined) {
  return normalizeOwnerId(vm?.owner_user_id)
}

export function vmOriginOf(vm: OwnedResource | null | undefined) {
  const origin = String(vm?.origin || '').trim()
  if (origin === VM_ORIGIN.adminAssigned || origin === VM_ORIGIN.userCreated || origin === VM_ORIGIN.platform) {
    return origin
  }
  return vmOwnerId(vm) ? VM_ORIGIN.adminAssigned : VM_ORIGIN.platform
}

export function proxyOwnerId(proxy: OwnedResource | null | undefined) {
  return normalizeOwnerId(proxy?.owner_user_id)
}

export type OwnerScope = { type: 'platform' } | { type: 'any' } | { type: 'none' } | { type: 'user'; userId: string | null }
export type KeyOwner = { user_id?: string | null }
export type OwnerRequest = { apiKeyKind?: string | null; apiKeyRecord?: KeyOwner | null; panelUser?: unknown; panelRole?: string; panelUserId?: string }
export type UserRoleReader = { getById(id: string): Promise<{ role: string } | null> }
type OwnedResource = { owner_user_id?: string | null; origin?: string }
type PanelActor = { role?: string; userId?: string }

export function ownerScopeFromApiKey(
  record: KeyOwner | null,
  { apiKeyKind = null, ownerRole = null }: { apiKeyKind?: string | null; ownerRole?: string | null } = {},
): OwnerScope {
  if (apiKeyKind === 'master') return PLATFORM_SCOPE
  const userId = normalizeOwnerId(record?.user_id)
  if (!userId) return PLATFORM_SCOPE
  const role = String(ownerRole || '')
    .trim()
    .toLowerCase()
  if (role === 'admin' || role === 'super') return PLATFORM_SCOPE
  return { type: 'user', userId }
}

export async function ownerScopeFromRequest(
  req: OwnerRequest | null,
  usersRepo: UserRoleReader | null = null,
): Promise<OwnerScope> {
  const rec = req?.apiKeyRecord || null
  if (!rec && req?.panelUser && req?.apiKeyKind !== 'master') {
    const role = String(req.panelRole || '').trim().toLowerCase()
    if (role === 'admin' || role === 'super') return PLATFORM_SCOPE
    const userId = normalizeOwnerId(req.panelUserId)
    return userId ? { type: 'user', userId } : { type: 'none' }
  }
  let ownerRole: string | null = null
  const userId = normalizeOwnerId(rec?.user_id)
  if (userId && usersRepo?.getById) {
    ownerRole = (await usersRepo.getById(userId))?.role || null
  }
  return ownerScopeFromApiKey(rec, { apiKeyKind: req?.apiKeyKind, ownerRole })
}

export function vmMatchesOwnerScope(vm: OwnedResource | null | undefined, scope: OwnerScope = PLATFORM_SCOPE) {
  const type = scope?.type || 'platform'
  if (type === 'any') return true
  const owner = vmOwnerId(vm)
  if (type === 'platform') return !owner
  if (scope.type === 'user') return owner === normalizeOwnerId(scope.userId)
  return false
}

export function filterVmsForPanel<T extends OwnedResource>(vms: T[], { role, userId }: PanelActor = {}): T[] {
  if (role === 'admin' || role === 'super') return vms
  const owner = normalizeOwnerId(userId)
  if (!owner) return []
  return (vms || []).filter((vm) => vmOwnerId(vm) === owner)
}

export function countUserCreatedVms(vms: OwnedResource[], userId: unknown) {
  const owner = normalizeOwnerId(userId)
  if (!owner) return 0
  return (vms || []).filter((vm) => vmOwnerId(vm) === owner && vmOriginOf(vm) === VM_ORIGIN.userCreated).length
}

export function canUserDeleteVm(vm: OwnedResource | null | undefined, userId: unknown) {
  return vmOwnerId(vm) === normalizeOwnerId(userId) && vmOriginOf(vm) === VM_ORIGIN.userCreated
}

export function canBindProxyToVm(proxy: OwnedResource, vm: OwnedResource, { role }: Pick<PanelActor, 'role'> = {}) {
  const pOwner = proxyOwnerId(proxy)
  const vOwner = vmOwnerId(vm)
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'user') return !!(pOwner && vOwner && pOwner === vOwner)
  // admin/super: user proxies stay off the platform pool
  if (pOwner && !vOwner) return false
  return true
}

export function assignOriginForOwner(
  ownerUserId: unknown,
  { previousOrigin = VM_ORIGIN.platform, actorRole = 'admin' }: { previousOrigin?: string; actorRole?: string } = {},
) {
  const owner = normalizeOwnerId(ownerUserId)
  if (!owner) return VM_ORIGIN.platform
  if (actorRole === 'user') return VM_ORIGIN.userCreated
  if (previousOrigin === VM_ORIGIN.userCreated) return VM_ORIGIN.userCreated
  return VM_ORIGIN.adminAssigned
}
