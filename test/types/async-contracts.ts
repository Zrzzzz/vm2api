import { ownerScopeFromRequest, vmMatchesOwnerScope } from '../../src/lib/admin/resource-owner.mts'
import { UsersRepo } from '../../src/lib/db/adapters/postgres/repos/users-repo.mts'
import type { UserRoleReader, OwnerScope } from '../../src/lib/admin/resource-owner.mts'

declare const users: UsersRepo
// The real PostgreSQL repository must satisfy the role reader contract.
const reader: UserRoleReader = users
const request = { apiKeyKind: 'managed', apiKeyRecord: { user_id: 'admin-1' } }
const pending = ownerScopeFromRequest(request, reader)
// @ts-expect-error A pending database query is not a user record.
users.getById('admin-1')?.role
// @ts-expect-error A pending scope is not a scheduling scope.
const invalidScope: OwnerScope = pending
// @ts-expect-error The VM filter must never accept a Promise.
vmMatchesOwnerScope({}, pending)
const scope: OwnerScope = await pending
vmMatchesOwnerScope({}, scope)
