import { api, type AttendanceStatus, type UserSession } from './api';
import { browserAuth, type AuthStatus } from './auth';
import { APP_NAME, APP_VERSION, DEMO_MODE, WORK_DAY_SECONDS } from './config';
import {
  addDays,
  formatFullDate,
  formatSecondsToHMS,
  formatSecondsToHmText,
  formatTimeOnly,
  getTodayDayIndex,
  getWeekMonday,
  secondsBetween,
  shortDayLabel,
  toIsoDate,
} from './utils/time';

interface DayView {
  date: string;
  label: string;
  attendanceId: number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  secondsWorked: number;
  status: 'checked_in' | 'checked_out' | 'not_checked_in';
}

const DAY_CHARS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const CLOUD_SYNC_MS = 60_000;

function emptyWeek(): DayView[] {
  const monday = getWeekMonday();
  return Array.from({ length: 7 }, (_, idx) => {
    const date = addDays(monday, idx);
    return {
      date: toIsoDate(date),
      label: shortDayLabel(date),
      attendanceId: null,
      checkInTime: null,
      checkOutTime: null,
      secondsWorked: 0,
      status: 'not_checked_in' as const,
    };
  });
}

function statusFromTimes(
  checkInTime: string | null,
  checkOutTime: string | null
): DayView['status'] {
  if (checkInTime && !checkOutTime) return 'checked_in';
  if (checkInTime && checkOutTime) return 'checked_out';
  return 'not_checked_in';
}

function mapStatusToDay(status: AttendanceStatus, day: DayView): DayView {
  const checkInTime = status.checkInTime;
  const checkOutTime = status.checkOutTime;
  const dayStatus = statusFromTimes(checkInTime, checkOutTime);
  const secondsWorked =
    dayStatus === 'checked_in'
      ? secondsBetween(checkInTime, new Date())
      : secondsBetween(checkInTime, checkOutTime);

  return {
    ...day,
    date: status.date || day.date,
    attendanceId: status.attendanceId,
    checkInTime,
    checkOutTime,
    secondsWorked,
    status: dayStatus,
  };
}

function mapApiRowToDay(row: Record<string, unknown>, day: DayView): DayView {
  const checkInTime =
    (row.checkInTime as string) ||
    (row.checkIn as string) ||
    (row.check_in_time as string) ||
    null;
  const checkOutTime =
    (row.checkOutTime as string) ||
    (row.checkOut as string) ||
    (row.check_out_time as string) ||
    null;
  const dayStatus = statusFromTimes(checkInTime, checkOutTime);
  const secondsWorked =
    typeof row.secondsWorked === 'number'
      ? row.secondsWorked
      : typeof row.workedSeconds === 'number'
        ? row.workedSeconds
        : dayStatus === 'checked_in'
          ? secondsBetween(checkInTime, new Date())
          : secondsBetween(checkInTime, checkOutTime);

  return {
    ...day,
    attendanceId:
      (row.attendanceId as number) ??
      (row.id as number) ??
      day.attendanceId,
    checkInTime,
    checkOutTime,
    secondsWorked,
    status: dayStatus,
  };
}

function loadDemoWeek(): DayView[] {
  const week = emptyWeek();
  const today = getTodayDayIndex();
  for (let i = 0; i < today; i++) {
    week[i] = {
      ...week[i],
      checkInTime: '09:00:00',
      checkOutTime: '17:30:00',
      secondsWorked: 8 * 3600 + 1800,
      status: 'checked_out',
      attendanceId: i + 1,
    };
  }
  return week;
}

export function initAttendanceApp(): void {
  const appRoot = document.getElementById('app');
  if (!appRoot) return;
  const root: HTMLElement = appRoot;

  let session: UserSession | null = null;
  let authStatus: AuthStatus = 'signed_out';
  let authMessage = '';
  let weekDays: DayView[] = emptyWeek();
  let selectedDayIndex = getTodayDayIndex();
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let syncInterval: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let historyOpen = false;
  let loadError: string | null = null;
  let booting = true;

  function showToast(message: string, isError = false) {
    const toast = document.getElementById('toast-msg');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function stopSync() {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  }

  function startTimerIfNeeded() {
    stopTimer();
    const todayIndex = getTodayDayIndex();
    const today = weekDays[todayIndex];
    if (!today || today.status !== 'checked_in') return;

    timerInterval = setInterval(() => {
      today.secondsWorked = secondsBetween(today.checkInTime, new Date());
      if (selectedDayIndex !== todayIndex) return;

      const timerEl = document.getElementById('worked-timer-value');
      if (timerEl) timerEl.textContent = formatSecondsToHMS(today.secondsWorked);

      const percent = Math.min(
        100,
        Math.round((today.secondsWorked / WORK_DAY_SECONDS) * 100)
      );
      const remaining = Math.max(0, WORK_DAY_SECONDS - today.secondsWorked);
      const fillEl = document.getElementById('progress-fill');
      const percentTextEl = document.getElementById('percent-worked-text');
      const remTextEl = document.getElementById('remaining-time-text');
      if (fillEl) fillEl.style.width = `${percent}%`;
      if (percentTextEl) percentTextEl.textContent = `${percent}% worked`;
      if (remTextEl) {
        remTextEl.textContent = `${formatSecondsToHmText(remaining)} remaining`;
      }
    }, 1000);
  }

  function startCloudSync() {
    stopSync();
    if (DEMO_MODE || !session) return;
    syncInterval = setInterval(() => {
      void refreshAttendanceData().then(() => {
        if (session) render();
      });
    }, CLOUD_SYNC_MS);
  }

  async function refreshAttendanceData() {
    if (!session) return;
    loadError = null;

    if (DEMO_MODE) {
      weekDays = loadDemoWeek();
      return;
    }

    const monday = getWeekMonday();
    const sunday = addDays(monday, 6);
    const base = emptyWeek();

    try {
      const [status, rows] = await Promise.all([
        api.getAttendanceStatus(session.organizationId, session.employeeId),
        api.getWeeklyAttendance(
          session.organizationId,
          session.employeeId,
          toIsoDate(monday),
          toIsoDate(sunday)
        ),
      ]);

      for (const row of rows) {
        const rowDate = String(
          row.date || row.attendanceDate || row.workDate || ''
        ).slice(0, 10);
        const idx = base.findIndex((d) => d.date === rowDate);
        if (idx >= 0) base[idx] = mapApiRowToDay(row, base[idx]);
      }

      const todayIndex = getTodayDayIndex();
      if (status.date === base[todayIndex].date || !status.date) {
        base[todayIndex] = mapStatusToDay(status, base[todayIndex]);
      } else {
        const idx = base.findIndex((d) => d.date === status.date);
        if (idx >= 0) base[idx] = mapStatusToDay(status, base[idx]);
      }

      weekDays = base;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load attendance';
      weekDays = base;
    }
  }

  async function bootstrapLoggedIn() {
    root.innerHTML = `
      <div class="loading-screen">
        <div class="loading-spinner"></div>
        <p>Loading attendance…</p>
      </div>
    `;
    await refreshAttendanceData();
    startCloudSync();
    render();
  }

  function renderAuthScreen() {
    stopTimer();
    stopSync();
    const waiting = authStatus === 'waiting_for_browser';
    const waitPhase = browserAuth.getWaitPhase();
    const waitLabel =
      waitPhase === 'connected'
        ? 'Browser connected…'
        : waiting
          ? 'Waiting for browser…'
          : 'Login on SkilledIM';
    const infoClass =
      waiting || authStatus === 'authenticated' ? 'auth-info' : 'auth-error';

    root.innerHTML = `
      <div class="auth-overlay">
        <div class="auth-modal companion-login">
          <div class="auth-logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
            </svg>
          </div>
          <h2>${APP_NAME}</h2>
          <div class="auth-hero-icon" aria-hidden="true">👨‍💼</div>

          ${authMessage ? `<div class="${infoClass}">${authMessage}</div>` : ''}

          <button type="button" class="auth-submit-btn" id="browser-login-btn" ${waiting ? 'disabled' : ''}>
            ${waitLabel}
          </button>

          ${
            waiting
              ? `<button type="button" class="auth-secondary-btn" id="cancel-login-btn">Cancel</button>
                 <p class="auth-help-text">Companion monitors the SkilledIM tab. Closing that tab ends waiting. If you are already signed in, Companion is authorized automatically.</p>`
              : `<p class="auth-help-text">Securely sign in through<br/>SkilledIM in your browser.</p>`
          }

          <div class="auth-footer-meta">
            ${APP_NAME} v${APP_VERSION}
          </div>
        </div>
      </div>
    `;

    document.getElementById('browser-login-btn')?.addEventListener('click', () => {
      void (async () => {
        try {
          await browserAuth.startBrowserLogin();
        } catch (err) {
          authMessage = err instanceof Error ? err.message : 'Unable to open SkilledIM';
          renderAuthScreen();
        }
      })();
    });

    document.getElementById('cancel-login-btn')?.addEventListener('click', () => {
      void browserAuth.cancelBrowserLogin();
    });
  }

  function render() {
    if (!session) {
      renderAuthScreen();
      return;
    }

    const todayIndex = getTodayDayIndex();
    const current = weekDays[selectedDayIndex] || emptyWeek()[selectedDayIndex];
    const isToday = selectedDayIndex === todayIndex;
    const isCheckedIn = current.status === 'checked_in';
    const percentWorked = Math.min(
      100,
      Math.round((current.secondsWorked / WORK_DAY_SECONDS) * 100)
    );
    const remainingSeconds = Math.max(0, WORK_DAY_SECONDS - current.secondsWorked);
    const initials = session.name
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    const dayPillsHtml = DAY_CHARS.map((dayChar, idx) => {
      const rec = weekDays[idx];
      const hasRec = rec && rec.status !== 'not_checked_in';
      return `<button class="day-pill ${idx === selectedDayIndex ? 'active' : ''} ${hasRec ? 'has-record' : ''}" data-day-index="${idx}" type="button">${dayChar}</button>`;
    }).join('');

    const historyRowsHtml = DAY_NAMES.map((dayName, idx) => {
      const rec = weekDays[idx];
      const isTodayRow = idx === todayIndex;
      const statusBadge =
        rec?.status === 'checked_in'
          ? '<span class="table-badge in">Checked In</span>'
          : rec?.status === 'checked_out'
            ? '<span class="table-badge done">Completed</span>'
            : '<span class="table-badge pending">Off / Pending</span>';

      return `
        <tr class="${isTodayRow ? 'today-row' : ''}">
          <td>${dayName}${isTodayRow ? ' (Today)' : ''}</td>
          <td>${formatTimeOnly(rec?.checkInTime)}</td>
          <td>${formatTimeOnly(rec?.checkOutTime)}</td>
          <td>${formatSecondsToHMS(rec?.secondsWorked ?? 0)}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');

    const statusBadgeHtml =
      current.status === 'checked_in'
        ? '<div class="status-badge checked-in"><span class="status-dot"></span>Checked In</div>'
        : current.status === 'checked_out'
          ? '<div class="status-badge checked-out"><span class="status-dot"></span>Checked Out</div>'
          : '<div class="status-badge"><span class="status-dot"></span>Not Checked In</div>';

    root.innerHTML = `
      <header class="app-header">
        <div class="company-brand">
          <div class="company-logo" title="${session.companyName}">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
            </svg>
          </div>
          <div class="company-info">
            <h2>${session.companyName}</h2>
            <span>Connected Organization · Agent Portal</span>
          </div>
        </div>

        <div class="user-profile">
          <div class="user-badge">
            <div class="user-avatar" title="${session.name}">${initials}</div>
            <div>
              <div class="user-name">${session.name}</div>
              <div class="user-role">${session.role}${DEMO_MODE ? ' · Demo' : ''}</div>
            </div>
          </div>
          <button id="logout-btn" class="logout-btn" type="button" title="Log out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            <span>Logout</span>
          </button>
        </div>
      </header>

      ${DEMO_MODE ? '<div class="demo-banner inline">DEMO MODE — attendance actions stay local</div>' : ''}
      ${loadError ? `<div class="inline-error">${loadError} <button type="button" id="retry-load-btn">Retry</button></div>` : ''}

      <main class="attendance-card">
        <div class="week-strip">${dayPillsHtml}</div>

        <div class="card-header">
          <div class="header-left">
            <div class="header-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
            </div>
            <div class="header-titles">
              <h1>${isToday ? formatFullDate(new Date()) : current.label}</h1>
              <p>Flexible 8 Hour · 8h 00m</p>
            </div>
          </div>
          <div class="header-right">${statusBadgeHtml}</div>
        </div>

        <div class="metrics-grid">
          <div class="metric-box check-in-box">
            <div class="metric-label">CHECK IN</div>
            <div class="metric-value ${current.checkInTime ? 'has-value' : ''}">
              ${formatTimeOnly(current.checkInTime)}
            </div>
            <div class="metric-sub">${current.checkInTime ? current.label : 'Not checked in'}</div>
          </div>

          <div class="metric-box active-worked">
            <div class="metric-label">WORKED</div>
            <div class="metric-value" id="worked-timer-value">${formatSecondsToHMS(current.secondsWorked)}</div>
            <div class="metric-sub">${formatSecondsToHmText(current.secondsWorked)} of 8h 00m</div>
          </div>

          <div class="metric-box check-out-box">
            <div class="metric-label">CHECK OUT</div>
            <div class="metric-value" style="color: ${current.checkOutTime ? '#1e293b' : '#ef4444'};">
              ${formatTimeOnly(current.checkOutTime)}
            </div>
            <div class="metric-sub">${current.checkOutTime ? 'Completed' : '--:--'}</div>
          </div>
        </div>

        <div class="progress-section">
          <div class="progress-track">
            <div class="progress-fill" id="progress-fill" style="width: ${percentWorked}%"></div>
          </div>
          <div class="progress-meta">
            <span id="percent-worked-text">${percentWorked}% worked</span>
            <span id="remaining-time-text">${formatSecondsToHmText(remainingSeconds)} remaining</span>
          </div>
        </div>

        ${
          isToday
            ? `
          <button id="attendance-cta-btn" class="cta-button ${isCheckedIn ? 'checkout-btn' : 'checkin-btn'}" type="button" ${busy ? 'disabled' : ''}>
            ${
              isCheckedIn
                ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg><span>${busy ? 'Working…' : 'Check Out'}</span>`
                : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg><span>${busy ? 'Working…' : 'Check In'}</span>`
            }
          </button>`
            : `<div class="history-hint">Viewing historical attendance for this day. Switch to today to mark attendance.</div>`
        }

        <footer class="card-footer">
          <div class="footer-item">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>${DEMO_MODE ? 'Demo session' : 'Synced from SkilledIM cloud'}</span>
          </div>
          <div class="footer-item">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
            <span>Desktop companion</span>
          </div>
        </footer>
      </main>

      <div class="history-toggle-wrap">
        <button id="toggle-history-btn" class="history-toggle-btn" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
          <span>${historyOpen ? 'Hide Weekly Attendance History' : 'View One-Week Attendance History'}</span>
        </button>
      </div>

      <div id="week-history-container" class="week-history-container ${historyOpen ? 'open' : ''}">
        <h3 class="history-title">Weekly Summary</h3>
        <table class="history-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Check In</th>
              <th>Check Out</th>
              <th>Worked</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${historyRowsHtml}</tbody>
        </table>
      </div>

      <div id="toast-msg" class="toast-msg"></div>
    `;

    bindEvents();
    startTimerIfNeeded();
  }

  function bindEvents() {
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
      stopTimer();
      stopSync();
      await browserAuth.signOut();
      session = null;
      weekDays = emptyWeek();
      showToast('Logged out successfully');
      renderAuthScreen();
    });

    document.getElementById('retry-load-btn')?.addEventListener('click', async () => {
      await bootstrapLoggedIn();
    });

    document.querySelectorAll('.day-pill').forEach((pill) => {
      pill.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        selectedDayIndex = Number(target.getAttribute('data-day-index') || '0');
        render();
      });
    });

    document.getElementById('toggle-history-btn')?.addEventListener('click', () => {
      historyOpen = !historyOpen;
      render();
    });

    document.getElementById('attendance-cta-btn')?.addEventListener('click', async () => {
      if (!session || busy) return;
      const todayIndex = getTodayDayIndex();
      const today = weekDays[todayIndex];
      busy = true;
      render();

      try {
        if (DEMO_MODE) {
          if (today.status === 'checked_in') {
            today.status = 'checked_out';
            today.checkOutTime = new Date().toISOString();
            today.secondsWorked = secondsBetween(today.checkInTime, today.checkOutTime);
          } else {
            today.status = 'checked_in';
            today.checkInTime = new Date().toISOString();
            today.checkOutTime = null;
            today.attendanceId = Date.now();
            today.secondsWorked = 0;
          }
          showToast(today.status === 'checked_in' ? 'Checked in successfully!' : 'Checked out successfully!');
        } else if (today.status === 'checked_in') {
          if (!today.attendanceId) throw new Error('Missing attendance id for check-out');
          const status = await api.checkOut(
            session.organizationId,
            session.employeeId,
            today.attendanceId
          );
          weekDays[todayIndex] = mapStatusToDay(status, today);
          showToast('Checked out successfully!');
        } else {
          const status = await api.checkIn(session.organizationId, session.employeeId);
          weekDays[todayIndex] = mapStatusToDay(status, today);
          showToast('Checked in successfully!');
        }
        selectedDayIndex = todayIndex;
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Attendance action failed', true);
      } finally {
        busy = false;
        if (!DEMO_MODE) await refreshAttendanceData();
        render();
      }
    });
  }

  root.innerHTML = `
    <div class="loading-screen">
      <div class="loading-spinner"></div>
      <p>Starting ${APP_NAME}…</p>
    </div>
  `;

  browserAuth.subscribe((nextSession, nextStatus, message) => {
    authStatus = nextStatus;
    authMessage = message || '';
    const wasAuthed = !!session;
    session = nextSession;

    if (booting) return;

    if (nextStatus === 'authenticated' && nextSession && !wasAuthed) {
      void bootstrapLoggedIn();
      return;
    }

    if (!nextSession) {
      stopTimer();
      stopSync();
      weekDays = emptyWeek();
      renderAuthScreen();
      return;
    }

    if (nextStatus === 'waiting_for_browser') {
      renderAuthScreen();
    }
  });

  void browserAuth.init().then(async () => {
    booting = false;
    session = browserAuth.getSession();
    authStatus = browserAuth.getStatus();
    if (session) {
      await bootstrapLoggedIn();
    } else {
      renderAuthScreen();
    }
  });
}
