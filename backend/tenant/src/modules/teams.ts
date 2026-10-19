import type { PoolClient } from 'pg'
import { z } from 'zod'
import { canManageTargetUser, getHighestCanonicalRole } from '../authorization.js'
import type { TenantModule, TenantSession } from './types.js'

// Core module: departments and groups of the workspace (team, team_membership).
// Managed from the workspace's admin area. Modules may grant access to a team
// (a table of their own referencing team(team_id)) but do not manage teams.
//
// Administrators manage every group. Managers manage the groups they created,
// may only include users they can manage.

const uuid = z.string().uuid()
const teamBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['department', 'group']),
  userIds: z.array(uuid).max(1000),
})

class TeamError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const isAdmin = (s: TenantSession) => s.permissions.has('tenant.settings.manage')

async function assertMembers(client: PoolClient, s: TenantSession, ids: string[]) {
  if (isAdmin(s) || !ids.length) return
  const users = (
    await client.query<{ user_id: string; roles: string[] }>(
      `select u.user_id, coalesce(array_agg(r.role_code) filter (where r.role_code is not null), '{}') as roles
         from user_account u
         left join role_assignment a on a.user_id = u.user_id and (a.expires_at is null or a.expires_at > now())
         left join role_definition r on r.role_id = a.role_id
        where u.user_id = any($1::uuid[]) group by u.user_id`,
      [ids],
    )
  ).rows
  if (users.length !== new Set(ids).size || users.some((u) => !canManageTargetUser(s.canonicalRole, getHighestCanonicalRole(u.roles))))
    throw new TeamError(403, 'Managers can add users and viewers only.')
}

async function assertManageable(client: PoolClient, s: TenantSession, id: string) {
  const team = (await client.query<{ created_by: string | null }>(`select created_by from team where team_id = $1 and team_status = 'active' for update`, [id])).rows[0]
  if (!team) throw new TeamError(404, 'Department or group not found.')
  if (isAdmin(s)) return
  if (team.created_by !== s.userId) throw new TeamError(403, 'Only an administrator can change this department or group.')
  const members = (await client.query<{ user_id: string }>('select user_id from team_membership where team_id = $1', [id])).rows
  await assertMembers(client, s, members.map((m) => m.user_id))
}

export function createTeamsModule(): TenantModule {
  return {
    code: 'teams',
    register(app, kit) {
      app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, request, reply) => {
        if (error instanceof z.ZodError) return reply.code(400).send({ success: false, message: 'Check the name, type and members.' })
        if (error instanceof TeamError) return reply.code(error.statusCode).send({ success: false, message: error.message })
        if (error.code === '23505') return reply.code(409).send({ success: false, message: 'A department or group with that name already exists.' })
        request.log.error({ err: error }, 'teams request failed')
        return reply.code(500).send({ success: false, message: 'The request could not be completed.' })
      })

      app.get('/api/v1/teams', async (request, reply) => {
        const s = await kit.requireSession(request, reply)
        if (!s || !(await kit.requirePermission(request, reply, s, 'tenant.users.read'))) return
        const teams = await kit.withTenant(request, async (client) =>
          (
            await client.query(
              `select t.team_id as id, t.name, t.group_kind as kind, t.created_at as "createdAt",
                      (t.created_by = $1::uuid or $2::boolean) as "canManage",
                      coalesce(array_agg(m.user_id) filter (where m.user_id is not null), '{}') as "userIds"
                 from team t left join team_membership m on m.team_id = t.team_id
                where t.team_status = 'active'
                group by t.team_id order by t.group_kind, lower(t.name)`,
              [s.userId, isAdmin(s)],
            )
          ).rows,
        )
        return { success: true, teams }
      })

      app.post('/api/v1/teams', async (request, reply) => {
        const s = await kit.requireSession(request, reply)
        if (!s || !(await kit.requirePermission(request, reply, s, 'tenant.users.roles')) || !kit.requireCsrf(request, reply, s)) return
        const b = teamBody.parse(request.body)
        return kit.withTenant(request, async (client) => {
          await assertMembers(client, s, b.userIds)
          const team = (await client.query<{ id: string }>('insert into team (name, group_kind, created_by) values ($1, $2, $3) returning team_id as id', [b.name, b.kind, s.userId])).rows[0]!
          await client.query('insert into team_membership (team_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing', [team.id, b.userIds])
          await client.query(
            `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id) values ($1, 'team:create', 'team', $2, 'success', $3)`,
            [s.userId, team.id, request.id],
          )
          return { success: true, team }
        })
      })

      app.put('/api/v1/teams/:id', async (request, reply) => {
        const s = await kit.requireSession(request, reply)
        if (!s || !(await kit.requirePermission(request, reply, s, 'tenant.users.roles')) || !kit.requireCsrf(request, reply, s)) return
        const { id } = z.object({ id: uuid }).parse(request.params)
        const b = teamBody.parse(request.body)
        return kit.withTenant(request, async (client) => {
          await assertManageable(client, s, id)
          await assertMembers(client, s, b.userIds)
          await client.query(`update team set name = $2, group_kind = $3, updated_at = now() where team_id = $1`, [id, b.name, b.kind])
          await client.query('delete from team_membership where team_id = $1', [id])
          await client.query('insert into team_membership (team_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing', [id, b.userIds])
          await client.query(
            `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id) values ($1, 'team:update', 'team', $2, 'success', $3)`,
            [s.userId, id, request.id],
          )
          return { success: true }
        })
      })

      // Archiving keeps history; members lose any access the team granted.
      app.delete('/api/v1/teams/:id', async (request, reply) => {
        const s = await kit.requireSession(request, reply)
        if (!s || !(await kit.requirePermission(request, reply, s, 'tenant.users.roles')) || !kit.requireCsrf(request, reply, s)) return
        const { id } = z.object({ id: uuid }).parse(request.params)
        return kit.withTenant(request, async (client) => {
          await assertManageable(client, s, id)
          // The name stays unique only among active groups, so the archived one steps aside.
          await client.query(
            `update team set team_status = 'archived', name = left(name, 70) || ' · archived ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), updated_at = now() where team_id = $1`,
            [id],
          )
          await client.query('delete from team_membership where team_id = $1', [id])
          await client.query(
            `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id) values ($1, 'team:archive', 'team', $2, 'success', $3)`,
            [s.userId, id, request.id],
          )
          return { success: true }
        })
      })
    },
  }
}
