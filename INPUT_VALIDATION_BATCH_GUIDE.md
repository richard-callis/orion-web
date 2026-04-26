# INPUT-001: Batch Completion Guide — Remaining 18 Routes

**Status**: 2/20 routes done (10%)  
**Pattern**: Established and documented below  
**Time to Complete**: ~8-10 hours for batched updates  

---

## Quick Pattern Reference

### Before:
```typescript
const body = await req.json()
if (!body.field) return NextResponse.json({ error: '...' }, { status: 400 })
const result = await prisma.model.create({ data: body })
```

### After:
```typescript
import { parseBodyOrError, CreateXSchema } from '@/lib/validate'

const result = await parseBodyOrError(req, CreateXSchema)
if ('error' in result) return result.error
const { data } = result  // type-safe

const dbResult = await prisma.model.create({ data })
```

---

## Remaining Routes (18) — Batch by Group

### AUTH ROUTES (6 remaining)

#### 1. POST /api/auth/totp/disable
**Schema**: `TOTPDisableSchema`  
**Current Validation**: None (only field is password)  
**Changes**:
```diff
+ import { parseBodyOrError, TOTPDisableSchema } from '@/lib/validate'

- const body = await req.json().catch(() => ({}))
- const { password } = body as { password?: string }
- if (!password) return NextResponse.json({ error: 'Password required' }, { status: 400 })

+ const result = await parseBodyOrError(req, TOTPDisableSchema)
+ if ('error' in result) return result.error
+ const { data } = result  // { password: string }
- // ... use password
+ // ... use data.password
```

#### 2. POST /api/auth/totp/recovery
**Schema**: `TOTPRecoverySchema`  
**Current Validation**: Check code exists  
**Changes**:
```diff
+ import { parseBodyOrError, TOTPRecoverySchema } from '@/lib/validate'

- const body = await req.json()
- const { code } = body as { code?: string }
- if (!code) return NextResponse.json({ error: 'Recovery code required' }, { status: 400 })

+ const result = await parseBodyOrError(req, TOTPRecoverySchema)
+ if ('error' in result) return result.error
+ const { data } = result  // { code: string }
- // ... use code
+ // ... use data.code
```

#### 3. POST /api/auth/totp/generate
**Schema**: None (no request body)  
**Current Validation**: None  
**Changes**: No validation needed (no body expected)

#### 4. POST /api/auth/mfa/verify
**Schema**: `MfaVerifySchema`  
**Current Validation**: Manual code length check  
**Changes**: Same pattern as TOTPVerifySchema

#### 5. POST /api/auth/totp-login
**Schema**: `TOTPLoginSchema`  
**Current Validation**: Manual field checks  
**Changes**:
```diff
+ import { parseBodyOrError, TOTPLoginSchema } from '@/lib/validate'

- const body = await req.json()
- const { username, password, totpCode, isRecovery } = body

+ const result = await parseBodyOrError(req, TOTPLoginSchema)
+ if ('error' in result) return result.error
+ const { data } = result  // { username, password, totpCode?, isRecovery? }
- // ... use fields
+ // ... use data.{field}
```

#### 6. POST /api/auth/[...nextauth]
**Note**: Handled by NextAuth — skip validation

---

### ADMIN ROUTES (6 remaining)

#### 7. POST /api/admin/users
**Schema**: `CreateUserSchema`  
**Current**: Manual validation on username/email/password  
**Changes**:
```diff
+ import { parseBodyOrError, CreateUserSchema } from '@/lib/validate'

- const body = await req.json()
- if (!body.username || body.username.length < 3) return 400
- if (!isValidEmail(body.email)) return 400
- if (!body.password || body.password.length < 8) return 400

+ const result = await parseBodyOrError(req, CreateUserSchema)
+ if ('error' in result) return result.error
+ const { data } = result  // fully validated
```

#### 8. PUT /api/admin/users/[id]
**Schema**: `UpdateUserSchema`  
**Current**: Similar manual validation  
**Changes**: Same pattern as above

#### 9. PUT /api/admin/settings
**Schema**: `UpdateSettingsSchema`  
**Current**: Minimal validation  
**Changes**:
```diff
+ import { parseBodyOrError, UpdateSettingsSchema } from '@/lib/validate'

+ const result = await parseBodyOrError(req, UpdateSettingsSchema)
+ if ('error' in result) return result.error
+ const { data } = result  // { key, value }
```

#### 10. PUT /api/admin/system-prompts/[key]
**Schema**: `UpdateSystemPromptSchema`  
**Current**: Manual validation  
**Changes**: Apply same pattern

#### 11. DELETE /api/admin/users/[id]
**Schema**: None (no body, uses URL param)  
**Changes**: No validation needed

#### 12. GET /api/admin/audit-log
**Schema**: None (query params, no body)  
**Changes**: No validation needed

---

### AGENT ROUTES (2 remaining)

#### 13. PUT /api/agents/[id]
**Schema**: `UpdateAgentSchema`  
**Current**: Manual validation  
**Changes**:
```diff
+ import { parseBodyOrError, UpdateAgentSchema } from '@/lib/validate'

+ const result = await parseBodyOrError(req, UpdateAgentSchema)
+ if ('error' in result) return result.error
+ const { data } = result
```

#### 14. DELETE /api/agents/[id]
**Schema**: None (no body)  
**Changes**: No validation needed

---

### TASK ROUTES (2 remaining)

#### 15. POST /api/tasks
**Schema**: `CreateTaskSchema`  
**Current**: Minimal validation  
**Changes**:
```diff
+ import { parseBodyOrError, CreateTaskSchema } from '@/lib/validate'

+ const result = await parseBodyOrError(req, CreateTaskSchema)
+ if ('error' in result) return result.error
+ const { data } = result
```

#### 16. PUT /api/tasks/[id]
**Schema**: `UpdateTaskSchema`  
**Current**: Minimal validation  
**Changes**: Same pattern

#### 17. DELETE /api/tasks/[id]
**Schema**: None (no body)  
**Changes**: No validation needed

---

### FEATURE/EPIC ROUTES (4 remaining)

#### 18. POST /api/features
**Schema**: `CreateFeatureSchema`  
**Current**: Minimal validation  
**Changes**:
```diff
+ import { parseBodyOrError, CreateFeatureSchema } from '@/lib/validate'

+ const result = await parseBodyOrError(req, CreateFeatureSchema)
+ if ('error' in result) return result.error
+ const { data } = result
```

#### 19. PUT /api/features/[id]
**Schema**: `UpdateFeatureSchema`  
**Current**: Minimal validation  
**Changes**: Same pattern

#### 20. POST /api/epics
**Schema**: `CreateEpicSchema`  
**Current**: Minimal validation  
**Changes**: Same pattern

#### 21. PUT /api/epics/[id]
**Schema**: `UpdateEpicSchema`  
**Current**: Minimal validation  
**Changes**: Same pattern

---

## Routes Summary Table

| Route | Schema | Import | Status | Effort |
|-------|--------|--------|--------|--------|
| POST /api/auth/totp/verify | TOTPVerifySchema | ✅ | DONE | — |
| POST /api/auth/totp/disable | TOTPDisableSchema | — | TODO | 5min |
| POST /api/auth/totp/recovery | TOTPRecoverySchema | — | TODO | 5min |
| POST /api/auth/totp/generate | None | — | SKIP | — |
| POST /api/auth/mfa/verify | MfaVerifySchema | — | TODO | 5min |
| POST /api/auth/totp-login | TOTPLoginSchema | — | TODO | 10min |
| POST /api/admin/users | CreateUserSchema | — | TODO | 10min |
| PUT /api/admin/users/[id] | UpdateUserSchema | — | TODO | 10min |
| PUT /api/admin/settings | UpdateSettingsSchema | — | TODO | 5min |
| PUT /api/admin/system-prompts/[key] | UpdateSystemPromptSchema | — | TODO | 5min |
| DELETE /api/admin/users/[id] | None | — | SKIP | — |
| GET /api/admin/audit-log | None | — | SKIP | — |
| POST /api/agents | CreateAgentSchema | ✅ | DONE | — |
| PUT /api/agents/[id] | UpdateAgentSchema | — | TODO | 5min |
| DELETE /api/agents/[id] | None | — | SKIP | — |
| POST /api/tasks | CreateTaskSchema | — | TODO | 5min |
| PUT /api/tasks/[id] | UpdateTaskSchema | — | TODO | 5min |
| DELETE /api/tasks/[id] | None | — | SKIP | — |
| POST /api/features | CreateFeatureSchema | — | TODO | 5min |
| PUT /api/features/[id] | UpdateFeatureSchema | — | TODO | 5min |
| POST /api/epics | CreateEpicSchema | — | TODO | 5min |
| PUT /api/epics/[id] | UpdateEpicSchema | — | TODO | 5min |

---

## Batching Strategy

### Batch 1: Auth Routes (6 routes, ~30 min)
- POST /api/auth/totp/disable
- POST /api/auth/totp/recovery
- POST /api/auth/mfa/verify
- POST /api/auth/totp-login
- (skip: POST /api/auth/totp/generate, POST /api/auth/[...nextauth])

### Batch 2: Admin Routes (4 routes, ~30 min)
- POST /api/admin/users
- PUT /api/admin/users/[id]
- PUT /api/admin/settings
- PUT /api/admin/system-prompts/[key]

### Batch 3: Agent/Task Routes (4 routes, ~20 min)
- PUT /api/agents/[id]
- POST /api/tasks
- PUT /api/tasks/[id]

### Batch 4: Feature/Epic Routes (4 routes, ~20 min)
- POST /api/features
- PUT /api/features/[id]
- POST /api/epics
- PUT /api/epics/[id]

**Total Time**: ~2 hours for all batches

---

## Completion Checklist

- [ ] Auth batch (6 routes)
- [ ] Admin batch (4 routes)
- [ ] Agent/Task batch (4 routes)
- [ ] Feature/Epic batch (4 routes)
- [ ] Test invalid inputs on all routes
- [ ] Verify error messages are clear
- [ ] Check for type safety in handlers
- [ ] Create PR with all 18 routes
- [ ] Merge to main

---

## Testing Checklist per Batch

For each updated route:
1. [ ] Valid input passes validation
2. [ ] Missing required field returns 400 with error detail
3. [ ] String length exceeding max returns 400
4. [ ] Invalid enum value returns 400
5. [ ] Error messages are clear and helpful

---

**Next**: Can be done in parallel with other issues, or batched together.
All pattern and schemas are in place. Just apply the same pattern to each route.
