# INPUT-001: Input Validation Tier 1

**Branch**: `fix/input-validation-tier1`
**Objective**: Add comprehensive Zod validation to 25-30 critical API routes
**Status**: Phase 2 in progress — 11/20 routes implemented (55%)
**Infrastructure**: COMPLETE (helper + 18 schemas in `lib/validate.ts`)

---

## Overview

**Before**: Zero input validation on 91 API routes
**After (Tier 1)**: Full validation on 25-30 critical routes (auth, admin, mutations)
**After (Tier 2)**: Full validation on internal service routes

**Compliance impact**: Moves from CRITICAL GAP to COMPLIANT on SOC2 auth/admin endpoints. Prevents SQL injection via oversized/malformed input and command injection via validated enums.

---

## Phase 1: Helper Function & Schemas — COMPLETE

### `parseBodyOrError` helper (`lib/validate.ts`)

```typescript
/**
 * Parse and validate request body against a Zod schema.
 * Returns either parsed data or a NextResponse error.
 */
export async function parseBodyOrError<T extends z.ZodType>(
  req: NextRequest,
  schema: T,
): Promise<{ data: z.infer<T> } | { error: NextResponse }> {
  try {
    const body = await req.json()
    const data = schema.parse(body)
    return { data }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        error: NextResponse.json(
          {
            error: 'Invalid request body',
            issues: err.issues.map(i => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          { status: 400 }
        )
      }
    }
    return {
      error: NextResponse.json(
        { error: 'Bad request' },
        { status: 400 }
      )
    }
  }
}
```

### Schemas Added (18 new + 3 existing = 21 total)

**Auth Schemas**:
```typescript
export const TOTPVerifySchema = z.object({
  code: z.string().length(6, 'Code must be 6 digits').regex(/^\d+$/, 'Code must be numeric'),
})
export const TOTPDisableSchema = z.object({
  password: z.string().min(1, 'Password required'),
})
export const RecoveryCodeSchema = z.object({
  code: z.string().min(1, 'Recovery code required'),
})
// Also: MfaVerifySchema, TOTPLoginSchema, TOTPRecoverySchema
```

**Admin Schemas**:
```typescript
export const CreateUserSchema = z.object({
  username: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid username'),
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().max(200).optional(),
  role: z.enum(['admin', 'user', 'readonly']).default('user'),
})
export const UpdateUserSchema = z.object({
  username: z.string().min(3).max(100).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  name: z.string().max(200).optional(),
  role: z.enum(['admin', 'user', 'readonly']).optional(),
  active: z.boolean().optional(),
})
export const UpdateSettingsSchema = z.object({
  key: z.string().min(1),
  value: z.string().max(10000),
})
export const UpdateSystemPromptSchema = z.object({
  key: z.string().min(1),
  name: z.string().max(200),
  content: z.string().max(50000),
})
```

**Agent/Task Schemas**:
```typescript
export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['claude', 'ollama', 'human', 'custom']),
  role: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
})
export const UpdateAgentSchema = CreateAgentSchema.partial()

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  priority: z.number().int().min(1).max(10).default(5),
  featureId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  assignedUserId: z.string().optional(),
})
export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  status: z.enum(['pending', 'running', 'done', 'failed']).optional(),
  assignedAgentId: z.string().optional(),
  assignedUserId: z.string().optional(),
})
```

**Feature/Epic Schemas**:
```typescript
export const CreateFeatureSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
  epicId: z.string().optional(),
})
export const UpdateFeatureSchema = CreateFeatureSchema.partial()

export const CreateEpicSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
})
export const UpdateEpicSchema = CreateEpicSchema.partial()
```

**Other Schemas**: `CreateToolApprovalSchema`, `UpdateConversationSchema`, `UpdateNoteSchema`, `CreateEnvironmentSchema` (pre-existing)

---

## Conversion Pattern

### Before (manual validation):
```typescript
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { code } = body as { code?: string }
  if (!code || typeof code !== 'string' || code.length !== 6) {
    return NextResponse.json({ error: '6-digit code required' }, { status: 400 })
  }
  // ... proceed with code
}
```

### After (Zod validation):
```typescript
import { parseBodyOrError, TOTPVerifySchema } from '@/lib/validate'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await parseBodyOrError(req, TOTPVerifySchema)
  if ('error' in result) return result.error
  const { data } = result  // { code: string } — type-safe

  // ... proceed with data.code
}
```

---

## Phase 2: Route Integration — In Progress

### All Routes Status

| Route | Schema | Status | Commit |
|-------|--------|--------|--------|
| POST /api/auth/totp/verify | TOTPVerifySchema | DONE | f02421c |
| POST /api/auth/totp/disable | TOTPDisableSchema | DONE | bac43d6 |
| POST /api/auth/totp/recovery | TOTPDisableSchema* | DONE | bac43d6 |
| POST /api/auth/mfa/verify | MfaVerifySchema | DONE | bac43d6 |
| POST /api/auth/totp-login | TOTPLoginSchema | DONE | bac43d6 |
| POST /api/auth/totp/generate | None (no body) | SKIP | — |
| POST /api/auth/[...nextauth] | None (NextAuth) | SKIP | — |
| POST /api/auth/signout | None (no body) | SKIP | — |
| POST /api/admin/users | CreateUserSchema | TODO | — |
| PUT /api/admin/users/[id] | UpdateUserSchema | TODO | — |
| PUT /api/admin/settings | UpdateSettingsSchema | TODO | — |
| PUT /api/admin/system-prompts/[key] | UpdateSystemPromptSchema | TODO | — |
| DELETE /api/admin/users/[id] | None (no body) | SKIP | — |
| GET /api/admin/audit-log | None (query params) | SKIP | — |
| POST /api/agents | CreateAgentSchema | DONE | (prior) |
| PUT /api/agents/[id] | UpdateAgentSchema | DONE | b709b55 |
| DELETE /api/agents/[id] | None (no body) | SKIP | — |
| POST /api/tasks | CreateTaskSchema | DONE | b709b55 |
| PUT /api/tasks/[id] | UpdateTaskSchema | DONE | b709b55 |
| DELETE /api/tasks/[id] | None (no body) | SKIP | — |
| POST /api/features | CreateFeatureSchema | DONE | 4ccc7d9 |
| PUT /api/features/[id] | UpdateFeatureSchema | DONE | 4ccc7d9 |
| POST /api/epics | CreateEpicSchema | DONE | 4ccc7d9 |
| PUT /api/epics/[id] | UpdateEpicSchema | DONE | 4ccc7d9 |
| POST /api/notes | CreateNoteSchema | TODO (optional) | — |
| PUT /api/notes/[id] | UpdateNoteSchema | TODO (optional) | — |
| PUT /api/conversations/[id] | UpdateConversationSchema | TODO (optional) | — |

*Note: POST /api/auth/totp/recovery uses `TOTPDisableSchema` (password field), not `TOTPRecoverySchema`

### Remaining Work

**Batch 2 — Admin Routes (4 routes, ~30 min)**:
- POST /api/admin/users
- PUT /api/admin/users/[id]
- PUT /api/admin/settings (note: actual route is PATCH, not PUT)
- PUT /api/admin/system-prompts/[key]

*Note: POST /api/admin/users route may not exist yet — may need implementation.*

**Optional Routes (3 routes, ~15 min)**:
- POST /api/notes
- PUT /api/notes/[id]
- PUT /api/conversations/[id]

**Database field names**: `assignedAgentId`, `assignedUserId` (not `assignedAgent`, `assignedUser`)

---

## Files to Modify

1. `lib/validate.ts` — helper + schemas (all in one place; already complete)
2. `api/auth/totp/verify/route.ts` — DONE
3. `api/auth/totp/disable/route.ts` — DONE
4. `api/auth/totp/recovery/route.ts` — DONE
5. `api/auth/mfa/verify/route.ts` — DONE
6. `api/auth/totp-login/route.ts` — DONE
7. `api/agents/route.ts` — DONE
8. `api/agents/[id]/route.ts` — DONE
9. `api/tasks/route.ts` — DONE
10. `api/tasks/[id]/route.ts` — DONE
11. `api/features/route.ts` — DONE
12. `api/features/[id]/route.ts` — DONE
13. `api/epics/route.ts` — DONE
14. `api/epics/[id]/route.ts` — DONE
15. `api/admin/users/route.ts` — TODO
16. `api/admin/users/[id]/route.ts` — TODO
17. `api/admin/settings/route.ts` — TODO
18. `api/admin/system-prompts/[key]/route.ts` — TODO
19. `api/environments/route.ts` — already has CreateEnvironmentSchema
20. `api/chat/conversations/[id]/route.ts` — optional

---

## Testing

### Per-Route Checklist

- [ ] Valid input passes validation
- [ ] Missing required field returns 400 with error detail
- [ ] String exceeding max length returns 400
- [ ] Invalid enum value returns 400
- [ ] Type safety in handler code (no manual casting)

### Quick curl Tests

```bash
# Valid input — expect success
curl -s -X POST http://localhost:3000/api/auth/totp/verify \
  -H "Content-Type: application/json" \
  -d '{"code": "123456"}'

# Invalid input — expect 400 with issues
curl -s -X POST http://localhost:3000/api/auth/totp/verify \
  -H "Content-Type: application/json" \
  -d '{"code": "abc"}'
# Response: {"error":"Invalid request body","issues":[{"path":"code","message":"Code must be numeric"}]}
```

---

## Success Criteria

- [ ] `parseBodyOrError` helper created and exported (DONE)
- [ ] All Tier 1 route schemas defined (DONE — 18 schemas)
- [ ] All 25-30 Tier 1 routes updated to use validation (55% done)
- [ ] Invalid input returns 400 with validation issues
- [ ] Valid input passes through cleanly
- [ ] No type errors in routes
- [ ] PR created and merged to main

---

## Timeline

- **Phase 1** (Helper + Schemas): COMPLETE
- **Phase 2a** (Auth/Agent/Task/Feature/Epic routes): COMPLETE (~2-3 hrs invested)
- **Phase 2b** (Admin routes + optional): ~45 min remaining
- **Phase 3** (Testing + PR): ~2 hrs

**Blockers**: None. All infrastructure in place; remaining work is mechanical.
