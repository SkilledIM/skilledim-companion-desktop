# SkilledIM Companion — Living Implementation Plan

**Repository:** `skilledim-companion-desktop` (`companion-desktop/`)  
**Document role:** Single source of truth for product scope, task tracking, verified API mapping, decisions, and execution prompts.  
**Rule:** Do not create additional planning, tracking, API-mapping, architecture, or prompt documents. Update this file only.  
**Related reference docs (not plans):** root `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `DEVELOPMENT.md`, `BUILD.md`, `RELEASE.md`.

**Last updated:** 2026-10-12 (initialization / audit)

---

## 1. Product Scope and Rules

### Purpose

SkilledIM Companion is a small, lightweight desktop utility inspired by the system-tray experience of OneDrive and Dropbox. Agents authorize through SkilledIM in the system browser, then view and mark attendance against existing SkilledIM cloud APIs. The Spring Boot backend remains the source of truth for attendance and business rules.

### Release 1 — Included

| Area | Requirement |
|------|-------------|
| Auth | Browser-based sign-in using a supported SkilledIM authentication flow |
| Identity | Real employee identity, profile image, organization branding |
| Status | Current attendance status from existing SkilledIM APIs |
| Actions | Check-in and check-out via existing Attendance / ESS APIs |
| Duration | Server-confirmed working duration where supported |
| History | Daily and weekly attendance history |
| Reminders | Attendance reminders and local snoozing |
| Reconciliation | Refresh when attendance changes via web or mobile ESS |
| Shell | System tray, background operation, optional startup |
| Resilience | Network recovery, session expiry, error handling |
| Security | Secure credential handling, minimal local storage, image-only caching |
| Release | Testing, packaging, release readiness |

### Explicitly Excluded

- Screenshots, screen recordings, camera monitoring
- Application usage tracking / productivity scoring
- Separate timesheet engine
- Separate attendance system / duplicate attendance rules
- Authoritative local attendance records
- Ad hoc caching of employee records, attendance API responses, or auth secrets
- Password collection inside Companion UI
- Companion documentation or code changes inside the Spring Boot backend repository

### Architecture Constraints

| Constraint | Detail |
|------------|--------|
| Work location | All Companion work stays in this desktop repository |
| Stack | Preserve current **Tauri 2 + Vite + TypeScript (vanilla UI) + Rust** stack. Do not introduce React unless a recorded decision changes this. |
| Backend SoT | Spring Boot APIs own attendance rules and records |
| API preference | Prefer existing verified APIs; propose new APIs only when a verified gap justifies them |
| Caching | Cache image assets only when appropriate; never cache attendance/auth payloads ad hoc |
| Scope discipline | No unrelated refactoring; no Companion docs in Spring Boot |
| Portal handoff | Companion opens portal login with `client_id` / `redirect_uri` / `state`; portal must redirect to `skilledim-companion://auth/callback` (portal change is outside this repo) |

### Agreed Decisions (baseline)

1. **No OAuth/PKCE inventing.** OpenAPI has no Authorization Code + PKCE. Companion uses browser JWT handoff + `POST /api/auth/validate-token`.
2. **Tokens in OS keyring only** (Rust `keyring`), never `localStorage` / plain files.
3. **Demo mode** (`VITE_DEMO_MODE=true`) may simulate UI without production attendance calls.
4. **Medium** on check-in/out currently sent as `WEBSITE`; evaluate a Companion-specific medium only if backend supports it (do not invent).

---

## 2. Task Tracker

Statuses: `NOT_STARTED` | `IN_PROGRESS` | `BLOCKED` | `IN_REVIEW` | `DONE` | `DEFERRED`

Never mark `DONE` without verified acceptance evidence.

| Task ID | Task name | Status | Dependencies | Acceptance criteria | Evidence or blocker | Next action |
|---------|-----------|--------|--------------|---------------------|---------------------|-------------|
| SC-001 | Audit the existing desktop repository and confirm scope | DONE | — | Repo layout, stack, existing features vs R1 scope documented; exclusions confirmed; no duplicate plan docs created | 2026-10-12 audit: Tauri 2 + Vite + vanilla TS + Rust; modules `src/api.ts`, `auth.ts`, `attendance.ts`, `secureStore.ts`; keyring + deep-link present; **no** tray/autostart/reminders/profile photo; stack is vanilla TS (not React) | Maintain this plan as tasks complete |
| SC-002 | Discover and map existing SkilledIM APIs | DONE | SC-001 | Auth, identity, status, check-in/out, history APIs recorded with method/path/auth/source; gaps listed as blockers/proposals | §3 API Mapping verified against backend controllers + Companion client + OpenAPI notes in `ARCHITECTURE.md` | Revisit only if backend contracts change |
| SC-003 | Verify browser-based authentication feasibility and secure token handling | BLOCKED | SC-002 | End-to-end: portal → deep link → state/TTL → validate-token → keyring; no password UI; session restore/signout work | **Companion side largely implemented** (`auth.ts`, `secure_store.rs`). **Blocker:** portal codebase has **no** `skilledim-companion` / callback redirect handling (grep 2026-10-12). Full E2E cannot pass until portal implements handoff (outside this repo) | Coordinate portal redirect; then run E2E on Windows; update evidence |
| SC-004 | Integrate employee identity and organization branding | NOT_STARTED | SC-002, SC-003 (partial OK with restore) | Show real name/role; load & display profile image; show org name + logo; image cache only | Session maps name/company/`companyLogoUrl`; UI uses initials + generic SVG — **no** photo/logo fetch yet. APIs: ESS profile, employee/user profile-photo download, `OrganizationDto.logoUrl` | Implement photo + logo fetch/display after auth path usable |
| SC-005 | Retrieve and refresh attendance status | IN_PROGRESS | SC-002, SC-003 | Status from ESS endpoint; reflects CHECK_IN/CHECK_OUT; periodic refresh; UI updates | `GET …/employee-self/{id}/attendance/status` + 60s sync in `attendance.ts`; needs E2E verification post-auth | Harden error/empty states; verify against live API |
| SC-006 | Implement check-in/check-out | IN_PROGRESS | SC-005 | Today check-in/out via Attendance APIs; UI disabled when not today; server confirms | `POST …/check-in` and `…/check-out` wired; demo path local-only | E2E test; confirm medium/location behavior |
| SC-007 | Display server-supported working duration | NOT_STARTED | SC-005, SC-008 | Prefer server `totalHours` (or equivalent) when present; live timer only while checked in; no local authoritative rules | UI computes duration client-side from timestamps; `AttendanceDto.totalHours` exists but Companion does not prefer it | Map `totalHours` → display; keep live tick only for open session |
| SC-008 | Display daily and weekly attendance history | IN_PROGRESS | SC-002 | Week strip + history table from date-range API; daily detail selectable | `GET …/attendance/employee/{id}/date-range` + UI present | Verify pagination/`content` shapes; empty weeks |
| SC-009 | Establish reminder eligibility using verified attendance and leave | NOT_STARTED | SC-005 | Eligibility uses live attendance + verified leave APIs; no invented rules | Leave APIs exist (`…/leave/requests/employee/{employeeId}` etc.); not wired in Companion | Map leave read APIs; define eligibility rules from product + backend behavior |
| SC-010 | Implement reminders, snoozing and cross-channel reconciliation | NOT_STARTED | SC-009, SC-011 | OS/local reminders; snooze local only; refresh reconciles web/mobile changes | No reminder/snooze code | Design local snooze store (non-attendance); wire notifications |
| SC-011 | Implement system tray, background lifecycle and startup options | NOT_STARTED | SC-001 | Tray icon/menu; close-to-tray; optional autostart; background refresh | No tray/autostart plugins in `lib.rs` / `package.json` | Add Tauri tray + autostart plugins; wire lifecycle |
| SC-012 | Implement network, session and error recovery | NOT_STARTED | SC-003, SC-005 | Offline messaging; retry; expired JWT → re-auth; no silent corrupt state | Partial: restore clears expired JWT; load error + Retry; no systematic offline/backoff | Centralize API error handling + reconnect |
| SC-013 | Validate security, privacy and local caching behavior | NOT_STARTED | SC-003, SC-004 | Keyring-only tokens; no attendance/employee response cache; image cache OK; CSP/logging reviewed | `SECURITY.md` + keyring exist; profile JSON in secure store (non-secret identity) — confirm allowed | Security pass + document evidence in this table |
| SC-014 | Run integration and regression tests | NOT_STARTED | SC-003–SC-013 | Automated and/or documented manual tests executed; failures recorded | Only `npm run typecheck` / build scripts; no test suite yet | Add smoke/E2E checklist; run and record results |
| SC-015 | Validate packaging and release readiness | NOT_STARTED | SC-014 | Installer builds; deep link registered; release checklist in `RELEASE.md` satisfied | `BUILD.md` / `RELEASE.md` exist; packaging not verified in this init | `tauri build` on target OS; update evidence |

---

## 3. API Mapping

Verified against SkilledIM Spring Boot controllers (in-repo evidence) and Companion client usage. OpenAPI: `https://api.skilledim.com/api-docs` (Authentication tag inspected per `ARCHITECTURE.md`). **Do not invent endpoints.**

Authorization unless noted: `Authorization: Bearer <JWT>` after successful validate-token / session.

### 3.1 Authentication

| Method | Path | Purpose | Request / response (relevant) | Auth | Source |
|--------|------|---------|--------------------------------|------|--------|
| POST | `/api/auth/validate-token?token=` | Cross-domain JWT validation; returns user/org/employee context | Query `token`; body unused. Response `ApiResponse` → `AuthResponse` (`user`, `organization`, `employee`, roles, etc.) | Token in query (documented cross-domain) | `AuthController.validateToken`; Companion `api.validateToken` |
| GET | `/api/auth/session` | Enrich / revalidate current session | Bearer JWT. Returns session/auth payload | Bearer | `AuthController`; Companion `tryCurrentSession` |
| POST | `/api/auth/signout` | Server-side sign-out | Bearer JWT | Bearer | `AuthController`; Companion `signOut` |
| POST | `/api/auth/signin` | Email/password login | **Not used by Companion UI** | — | OpenAPI / `AuthController` |

**Browser handoff (portal contract — not an API):**

```text
GET {PORTAL}/login?client_id=skilledim-companion&redirect_uri=skilledim-companion://auth/callback&response_type=token&state={csrf}&source=SkilledIM Companion
→ redirect skilledim-companion://auth/callback?token={jwt}&state={csrf}
```

| Gap | Severity | Notes |
|-----|----------|-------|
| Portal companion redirect / authorize step | **BLOCKER for SC-003 E2E** | No `companion` / `skilledim-companion` handling found in `portal/src` (2026-10-12). Proposed change: portal-only (outside this repo). Do not modify Spring Boot for this. |
| OAuth 2.0 / PKCE | N/A | Not offered by OpenAPI; intentionally not invented |

### 3.2 Employee identity and branding

| Method | Path | Purpose | Request / response (relevant) | Auth | Source |
|--------|------|---------|--------------------------------|------|--------|
| (via validate-token / session) | — | Name, email, role, `employee.id`, `organization.name`, `organization.logoUrl` | `AuthResponse.user`, `.employee`, `.organization` (`OrganizationDto.logoUrl`) | Token | `AuthResponse`, `OrganizationDto`, Companion `mapSession` |
| GET | `/api/organizations/{organizationId}/employee-self/{employeeId}` | ESS “my profile” | `EmployeeDto` incl. `profilePhotoDocumentId` | Bearer + ESS access | `EmployeeSelfServiceController.getMyProfile` |
| GET | `/api/organizations/{organizationId}/employees/{employeeId}/profile-photo/download` | Employee profile image bytes | Binary download | Bearer | `EmployeeController` |
| GET | `/api/organizations/{organizationId}/users/{userId}/profile-photo/download` | User profile image (alternate) | Binary download | Bearer | `UserController` / `UserSelfController` |

| Gap | Severity | Notes |
|-----|----------|-------|
| Companion does not yet call profile-photo download or render `logoUrl` | Feature gap (SC-004) | Fields/APIs exist; UI incomplete |
| Dedicated “branding” endpoint | None verified | Use org from auth/session + `logoUrl` |

### 3.3 Attendance status

| Method | Path | Purpose | Request / response (relevant) | Auth | Source |
|--------|------|---------|--------------------------------|------|--------|
| GET | `/api/organizations/{organizationId}/employee-self/{employeeId}/attendance/status` | Which action to show; latest times | `AttendanceStatusDto`: `action` (`CHECK_IN`\|`CHECK_OUT`), `attendanceId`, `date`, `checkInTime`, `checkOutTime` — **no duration field** | Bearer + ESS | `EmployeeSelfServiceController`; Companion `getAttendanceStatus` |

### 3.4 Check-in / check-out

| Method | Path | Purpose | Request / response (relevant) | Auth | Source |
|--------|------|---------|--------------------------------|------|--------|
| POST | `/api/organizations/{organizationId}/attendance/employee/{employeeId}/check-in` | Record check-in | Body: `date`, `medium`, `location` (Companion sends `medium: "WEBSITE"`, `location: null`). Server stores check-in in UTC | Bearer | `AttendanceController`; Companion `checkIn` |
| POST | `/api/organizations/{organizationId}/attendance/employee/{employeeId}/attendance/{attendanceId}/check-out` | Record check-out | Body: `medium`, `location`. Requires `attendanceId` from status | Bearer | `AttendanceController`; Companion `checkOut` |

| Gap | Severity | Notes |
|-----|----------|-------|
| Companion-specific `medium` enum value | Unverified | Do not invent; keep `WEBSITE` unless backend documents another value |
| ESS-specific check-in/out alternate paths | Not required if Attendance paths work with employee JWT | Prefer existing Attendance Management paths already wired |

### 3.5 History and working duration

| Method | Path | Purpose | Request / response (relevant) | Auth | Source |
|--------|------|---------|--------------------------------|------|--------|
| GET | `/api/organizations/{organizationId}/attendance/employee/{employeeId}/date-range?startDate=&endDate=&size=` | History for range | Page/list of `AttendanceDto`: `id`, `date`, `checkInTime`, `checkOutTime`, **`totalHours`**, `status`, etc. | Bearer | `AttendanceController`; Companion `getWeeklyAttendance` |

| Gap | Severity | Notes |
|-----|----------|-------|
| Live “worked so far” while still checked in | Partial | Status DTO has no duration; derive live tick from `checkInTime` until check-out; prefer `totalHours` after check-out |
| Dedicated duration-only endpoint | Not found | Use `AttendanceDto.totalHours` |

### 3.6 Leave (reminder eligibility — SC-009)

| Method | Path | Purpose | Request / response (relevant) | Auth | Source |
|--------|------|---------|--------------------------------|------|--------|
| GET | `/api/organizations/{organizationId}/leave/requests/employee/{employeeId}` | Leave requests for employee | List of leave requests (status, dates) | Bearer | Portal constants + Leave controllers (portal `apis/constants`) |

Exact leave DTO fields and “on leave today” semantics must be confirmed against backend before encoding eligibility. Record findings here when SC-009 runs.

### 3.7 Proposed changes (outside Companion repo)

| Proposal | Why | Owner |
|----------|-----|-------|
| Portal: companion login redirect with `token` + `state` | Required for browser auth E2E | Portal team (not Spring Boot Companion docs; not this repo) |
| Optional: backend `medium` value for desktop companion | Analytics only; not required for R1 if `WEBSITE` accepted | Backend — only if product requires |

**Do not modify the Spring Boot repository from Companion workstreams.**

---

## 4. Implementation Decisions

| ID | Decision | Rationale | Unresolved |
|----|----------|-----------|------------|
| D-01 | Single living plan at `docs/IMPLEMENTATION-PLAN.md` | User requirement; avoid doc sprawl | — |
| D-02 | Keep vanilla TypeScript UI (not React) | Current repo stack; task text mentioned React but codebase does not use it | Confirm if product later mandates React |
| D-03 | Browser JWT handoff + validate-token | Only documented cross-domain auth mechanism | Portal redirect implementation |
| D-04 | Prefer Attendance Management check-in/out paths already in client | Verified controllers; ESS status for button state | Whether ESS-only orgs need different paths |
| D-05 | Prefer `AttendanceDto.totalHours` for completed sessions | Server-calculated; avoid duplicate rules | Rounding/display format |
| D-06 | Image-only disk/memory cache for photos/logos | Privacy constraint | Cache eviction policy |
| D-07 | Local snooze state only (not attendance truth) | Reconciliation via API refresh | Storage mechanism (secure vs app-data) |
| D-08 | Tray/autostart via official Tauri 2 plugins when SC-011 starts | Match OneDrive/Dropbox-style UX | Exact menu IA |

---

## 5. Execution Prompts

### 5.1 Master execution prompt

```text
You are implementing SkilledIM Companion inside the skilledim-companion-desktop repository only.

Before any code changes:
1. Read docs/IMPLEMENTATION-PLAN.md end-to-end (scope, constraints, API mapping, assigned task).
2. Inspect the current code and verify dependencies for the assigned task.
3. Work only on the assigned task and its necessary dependencies.
4. Reuse existing SkilledIM APIs and business logic; do not invent endpoints; do not modify the Spring Boot repo; do not add Companion docs there.
5. Implement and test against the task’s acceptance criteria.
6. Update docs/IMPLEMENTATION-PLAN.md after the task: status, evidence/blocker, changed files, next action, and §6 Completion Summary.
7. Never claim tests passed if they were not run.
8. Never create another planning or tracking document.

Respect exclusions (no screenshots/monitoring/productivity/timesheet engine/duplicate attendance system).
Preserve Tauri 2 + Vite + TypeScript + Rust. Cache images only; no ad hoc attendance/auth response caches.
```

### 5.2 Task-specific prompts

Each prompt assumes the master prompt above.

**SC-001 — Audit**
```text
Assigned: SC-001. Confirm repository layout vs R1 scope; update the tracker evidence only. Do not implement features.
```

**SC-002 — API mapping**
```text
Assigned: SC-002. Verify auth/identity/attendance/history APIs from Swagger and backend controllers; update §3 only with verified facts; list gaps as blockers/proposals. Do not invent endpoints. Do not modify Spring Boot.
```

**SC-003 — Browser auth**
```text
Assigned: SC-003. Verify deep-link + state + keyring + validate-token. Document portal gaps as blockers (portal work is outside this repo). Test what can be tested; do not claim E2E pass without portal redirect.
```

**SC-004 — Identity & branding**
```text
Assigned: SC-004. Load profile image and organization logo via verified APIs; display real identity. Cache images only. Update this plan with evidence.
```

**SC-005 — Attendance status**
```text
Assigned: SC-005. Ensure ESS attendance status fetch/refresh is correct and resilient. No local authoritative status store.
```

**SC-006 — Check-in/out**
```text
Assigned: SC-006. Wire/verify Attendance check-in and check-out; refresh status from server after actions. Do not invent medium values.
```

**SC-007 — Working duration**
```text
Assigned: SC-007. Prefer server totalHours when present; live timer only for open check-in. No duplicate attendance rules.
```

**SC-008 — History**
```text
Assigned: SC-008. Daily/weekly history from date-range API; handle empty and paged responses.
```

**SC-009 — Reminder eligibility**
```text
Assigned: SC-009. Use verified attendance + leave APIs only; document eligibility rules and any API gaps in this plan.
```

**SC-010 — Reminders & reconciliation**
```text
Assigned: SC-010. Local reminders + snooze; reconcile via API refresh (web/mobile changes). No local attendance authority.
```

**SC-011 — Tray / background / startup**
```text
Assigned: SC-011. System tray, background lifecycle, optional autostart using Tauri 2 plugins. Minimal scope.
```

**SC-012 — Network / session / errors**
```text
Assigned: SC-012. Offline, retry, session expiry → re-auth. Update plan with tested scenarios.
```

**SC-013 — Security & caching**
```text
Assigned: SC-013. Validate keyring, no secrets in logs, image-only cache, minimal local storage. Record evidence.
```

**SC-014 — Tests**
```text
Assigned: SC-014. Run integration/regression (or documented manual suite). Record actual results; never claim unrun tests passed.
```

**SC-015 — Packaging / release**
```text
Assigned: SC-015. Validate tauri build, deep-link registration, RELEASE.md checklist. Record artifacts/OS evidence.
```

---

## 6. Completion Summary

| | |
|--|--|
| **Completed** | SC-001 (repo audit), SC-002 (API mapping into this document) |
| **In progress** | SC-005, SC-006, SC-008 (client code present; E2E/auth-dependent verification pending) |
| **Blocked** | **SC-003** — portal lacks Companion redirect/`token`+`state` handoff; Companion auth client and keyring are largely ready |
| **Not started** | SC-004, SC-007, SC-009–SC-015 (SC-004/007 have clear API hooks) |
| **Outstanding blockers** | (1) Portal companion authorize/redirect implementation (outside this repo). (2) Reminder eligibility leave semantics not yet confirmed in Companion. (3) No tray/autostart yet. |
| **Recommended next task** | **Unblock SC-003** via portal handoff (coordinate outside Companion), then **SC-004** (profile image + org logo) in this repo. If portal work is delayed, proceed with **SC-007** (prefer `totalHours`) and **SC-011** (tray/autostart) in parallel on demo/restored-session paths where possible. |

### Changed files (this initialization)

- `docs/IMPLEMENTATION-PLAN.md` — created (this file)

### Tests run (this initialization)

- None (documentation-only initialization). Repository inspection and backend/portal greps only. Typecheck/build not executed.
`)
