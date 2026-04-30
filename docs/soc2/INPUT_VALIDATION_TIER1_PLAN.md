# INPUT-001: Tier 1 Input Validation Implementation Plan

**Branch**: `fix/input-validation-tier1`  
**Objective**: Add comprehensive Zod validation to 25-30 critical API routes  
**Status**: Ready for implementation  

---

## Phase 1: Helper Function & Base Schemas

### Step 1.1: Create `parseBodyOrError` Helper (lib/validate.ts)

Add to `lib/validate.ts`:

```typescript
/**
 * Parse and validate request body against a Zod schema.
 * Returns either parsed data or a NextResponse error.
 * 
 * Usage:
 *   const result = await parseBodyOrError(req, MySchema)
 *   if ('error' in result) return result.error
 *   const { data } = result  // type-safe T
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

### Step 1.2: Add Tier 1 Schemas (lib/validate.ts)

Add these schema definitions:

#### Auth Routes
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
```

#### Admin Routes
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

#### Agent/Task Routes
```typescript
export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['claude', 'ollama', 'human', 'custom']),
  role: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.enum(['claude', 'ollama', 'human', 'custom']).optional(),
  role: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
})

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

#### Feature/Epic Routes
```typescript
export const CreateFeatureSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
  epicId: z.string().optional(),
})

export const UpdateFeatureSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional(),
  epicId: z.string().optional(),
})

export const CreateEpicSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).default('pending'),
})

export const UpdateEpicSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  plan: z.string().max(10000).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional(),
})
```

#### Tool Approval Routes
```typescript
export const CreateToolApprovalSchema = z.object({
  toolName: z.string().min(1),
  toolArgs: z.record(z.unknown()).optional(),
  reason: z.string().max(500).optional(),
})
```

---

## Phase 2: Integrate into Tier 1 Routes

### Routes to Update (25-30 routes)

**Auth Routes** (8 routes):
- [ ] `POST /api/auth/totp/verify` → TOTPVerifySchema
- [ ] `POST /api/auth/totp/disable` → TOTPDisableSchema
- [ ] `POST /api/auth/totp/recovery` → RecoveryCodeSchema
- [ ] `POST /api/auth/totp/generate` → {} (no body)
- [ ] `POST /api/auth/mfa/verify` → MfaVerifySchema (new)
- [ ] `POST /api/auth/totp-login` → TOTPLoginSchema (new)
- [ ] `POST /api/auth/signin` → (handled by NextAuth)
- [ ] `POST /api/auth/signout` → (no body)

**Admin Routes** (7 routes):
- [ ] `POST /api/admin/users` → CreateUserSchema
- [ ] `PUT /api/admin/users/[id]` → UpdateUserSchema
- [ ] `DELETE /api/admin/users/[id]` → (no body)
- [ ] `PUT /api/admin/settings` → UpdateSettingsSchema
- [ ] `PUT /api/admin/system-prompts/[key]` → UpdateSystemPromptSchema
- [ ] `GET /api/admin/audit-log` → (query params, no body)
- [ ] `POST /api/admin/*` → (various)

**Agent Routes** (4 routes):
- [ ] `POST /api/agents` → CreateAgentSchema
- [ ] `PUT /api/agents/[id]` → UpdateAgentSchema
- [ ] `DELETE /api/agents/[id]` → (no body)
- [ ] `POST /api/agents/[id]/chat` → CreateConversationSchema

**Task Routes** (4 routes):
- [ ] `POST /api/tasks` → CreateTaskSchema
- [ ] `PUT /api/tasks/[id]` → UpdateTaskSchema
- [ ] `DELETE /api/tasks/[id]` → (no body)
- [ ] `GET /api/tasks/[id]` → (no body)

**Feature/Epic Routes** (4 routes):
- [ ] `POST /api/features` → CreateFeatureSchema
- [ ] `PUT /api/features/[id]` → UpdateFeatureSchema
- [ ] `POST /api/epics` → CreateEpicSchema
- [ ] `PUT /api/epics/[id]` → UpdateEpicSchema

**Environment Routes** (2 routes):
- [ ] `POST /api/environments` → CreateEnvironmentSchema (already exists)
- [ ] `PUT /api/environments/[id]` → UpdateEnvironmentSchema (new)

**Other Routes** (2 routes):
- [ ] `POST /api/chat/conversations` → CreateConversationSchema (already exists)
- [ ] `PATCH /api/chat/conversations/[id]` → UpdateConversationSchema (new)

---

## Phase 3: Testing & Verification

For each updated route:
1. [ ] Add validation call
2. [ ] Test with valid input
3. [ ] Test with invalid input (should get 400 with issues)
4. [ ] Test missing required fields
5. [ ] Test oversized strings (should be rejected)
6. [ ] Verify type safety in handler

---

## Example Conversion Pattern

### Before:
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

### After:
```typescript
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await parseBodyOrError(req, TOTPVerifySchema)
  if ('error' in result) return result.error
  
  const { data } = result  // { code: string } — type-safe
  
  // ... proceed with code
}
```

---

## Files to Modify

1. **lib/validate.ts** — Add helper + schemas (all in one place)
2. **api/auth/totp/verify/route.ts** — Update to use validation
3. **api/auth/totp/disable/route.ts** — Update to use validation
4. **api/auth/totp/recovery/route.ts** — Update to use validation
5. **api/admin/users/route.ts** — Update POST to use validation
6. **api/admin/users/[id]/route.ts** — Update PUT to use validation
7. **api/admin/settings/route.ts** — Update PUT to use validation
8. **api/admin/system-prompts/[key]/route.ts** — Update PUT to use validation
9. **api/agents/route.ts** — Update POST to use validation
10. **api/agents/[id]/route.ts** — Update PUT to use validation
11. **api/tasks/route.ts** — Update POST to use validation
12. **api/tasks/[id]/route.ts** — Update PUT to use validation
13. **api/features/route.ts** — Update POST to use validation
14. **api/features/[id]/route.ts** — Update PUT to use validation
15. **api/epics/route.ts** — Update POST to use validation
16. **api/epics/[id]/route.ts** — Update PUT to use validation
17. **api/environments/route.ts** — Update POST to use validation
18. **api/environments/[id]/route.ts** — Update PUT to use validation
19. **api/chat/conversations/route.ts** — Update POST to use validation
20. **api/chat/conversations/[id]/route.ts** — Update PATCH to use validation

---

## Success Criteria

- [ ] `parseBodyOrError` helper created and exported
- [ ] All Tier 1 route schemas defined
- [ ] All 25-30 Tier 1 routes updated to use validation
- [ ] Invalid input returns 400 with validation issues
- [ ] Valid input passes through cleanly
- [ ] No type errors in routes (type-safe usage)
- [ ] Compliance review updated
- [ ] PR created with security analysis
- [ ] All tests passing

---

## Timeline

- **Phase 1** (Helper + Schemas): 2-3 hours
- **Phase 2** (Route Updates): 6-8 hours (parallel-able by route)
- **Phase 3** (Testing + PR): 2 hours

**Total**: ~10 hours of work (2 days)
