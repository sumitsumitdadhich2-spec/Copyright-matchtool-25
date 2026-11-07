import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { DATA_DIR } from './paths';
import {
  loadDecryptedPlaywrightYtCookies,
  loadStudioUserConfig,
  saveStudioUserConfig,
  saveUserYtCookies,
} from './studio-settings';
import { MEDIA_DIR } from './paths';
import {
  markAllChannelClipsYtDeleted,
  readClipYtSidecar,
  saveClipYtSidecar,
} from './studio-window-clips';

export interface YtStepLog {
  ts: number;
  step: string;
  detail: string;
  status: 'info' | 'ok' | 'warn' | 'error';
}

export interface YtOpenTabInfo {
  index: number;
  url: string;
  active: boolean;
}

export interface YtContentVideoItem {
  title: string;
  videoId: string;
  ytUrl: string;
  windowNumber: number | null;
  scanPrefix: string | null;
  visibility: string;
  restrictions: string;
  isReady: boolean;
  isProcessingSd: boolean;
  hasClaim: boolean;
}

export interface YtContentProgressSummary {
  checkedAt: number;
  totalInContent: number;
  expectedCount: number;
  uploadedCount: number;
  readyCount: number;
  processingCount: number;
  claimedCount: number;
  allReady: boolean;
  items: YtContentVideoItem[];
}

export interface YtControllerSnapshot {
  status: 'idle' | 'starting' | 'ready' | 'uploading' | 'deleting' | 'paused' | 'assist' | 'error';
  assistMode: boolean;
  currentStep: string;
  currentUrl: string;
  channelId: string | null;
  channelHandle: string | null;
  logs: YtStepLog[];
  lastError: string | null;
  screenshotBase64?: string | null;
  viewport: { width: number; height: number };
  openTabs?: YtOpenTabInfo[];
  contentProgress?: YtContentProgressSummary | null;
}

class GlobalYtStudioUploadGate {
  private active = 0;
  private maxConcurrent = 1;
  private queue: Array<() => void> = [];

  setMaxConcurrent(n: number): void {
    const clamped = Math.max(1, Math.min(5, Math.floor(Number(n) || 1)));
    this.maxConcurrent = clamped;
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.active++;
        next();
      }
    }
  }

  getStats(): { active: number; maxConcurrent: number; queued: number } {
    return {
      active: this.active,
      maxConcurrent: this.maxConcurrent,
      queued: this.queue.length,
    };
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        const next = this.queue.shift();
        if (next) {
          this.active++;
          next();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active = Math.max(0, this.active - 1);
          const next = this.queue.shift();
          if (next) {
            this.active++;
            next();
          }
        });
      });
    });
  }
}

function getGlobalYtUploadGate(): GlobalYtStudioUploadGate {
  const g = globalThis as unknown as { __cmtYtStudioUploadGate?: GlobalYtStudioUploadGate };
  if (!g.__cmtYtStudioUploadGate) {
    g.__cmtYtStudioUploadGate = new GlobalYtStudioUploadGate();
  }
  return g.__cmtYtStudioUploadGate;
}

export const globalYtStudioUploadGate = getGlobalYtUploadGate();

function resolveSystemChromePath(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function cleanStaleSingletonLocks(profileDir: string): void {
  for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(profileDir, lockName);
    try {
      if (fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) {
        fs.unlinkSync(p);
      }
    } catch {
      // ignore
    }
  }
}

export class YtStudioBrowserController {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launchPromise: Promise<Page> | null = null;
  private status: YtControllerSnapshot['status'] = 'idle';
  private assistMode = false;
  private paused = false;
  private stopRequested = false;
  private currentStep = 'Idle';
  private lastError: string | null = null;
  private channelId: string | null = null;
  private channelHandle: string | null = null;
  private logs: YtStepLog[] = [];
  private viewport = { width: 1366, height: 820 };
  private actionLock: Promise<void> = Promise.resolve();
  private boundContext: BrowserContext | null = null;
  private manualTabSelection = false;
  private inFlightClipUploads: Map<
    string,
    Promise<{ ytUrl: string; ytVideoId: string; reused: boolean }>
  > = new Map();
  private busyUploadPages: Set<Page> = new Set();
  private contentProgress: YtContentProgressSummary | null = null;
  private dailyUploadLimitReached = false;
  private uploadedVideoIdsInSession: Set<string> = new Set();
  private unlistedFixQueue: Promise<void> = Promise.resolve();
  private unlistedFixQueuePending = 0;

  private ensureInternalCollections(): void {
    if (!this.inFlightClipUploads) {
      this.inFlightClipUploads = new Map();
    }
    if (!this.busyUploadPages) {
      this.busyUploadPages = new Set();
    }
    if (this.contentProgress === undefined) {
      this.contentProgress = null;
    }
    if (this.dailyUploadLimitReached === undefined) {
      this.dailyUploadLimitReached = false;
    }
    if (!this.uploadedVideoIdsInSession) {
      this.uploadedVideoIdsInSession = new Set();
    }
    if (!this.unlistedFixQueue) {
      this.unlistedFixQueue = Promise.resolve();
    }
    if (typeof this.unlistedFixQueuePending !== 'number') {
      this.unlistedFixQueuePending = 0;
    }
  }

  public isDailyUploadLimitReached(): boolean {
    this.ensureInternalCollections();
    return false;
  }

  public getContentProgress(): YtContentProgressSummary | null {
    this.ensureInternalCollections();
    return this.contentProgress || null;
  }

  public resetDailyUploadLimitFlag(): void {
    this.ensureInternalCollections();
    this.dailyUploadLimitReached = false;
  }

  public markDailyUploadLimitReached(_reason?: string): void {
    this.ensureInternalCollections();
    this.dailyUploadLimitReached = false;
  }

  private getPersistedLogsPath(): string {
    return path.join(DATA_DIR, 'yt-studio-step-logs.json');
  }

  private syncLogsFromDiskIfNeeded(): void {
    try {
      const logFile = this.getPersistedLogsPath();
      if (!fs.existsSync(logFile)) return;
      const raw = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      if (!Array.isArray(raw)) return;
      const diskLogs = raw.filter(
        (item): item is YtStepLog =>
          item &&
          typeof item.ts === 'number' &&
          typeof item.step === 'string' &&
          typeof item.detail === 'string'
      );
      if (diskLogs.length === 0) return;
      if (this.logs.length === 0) {
        this.logs = diskLogs.slice(0, 500);
        return;
      }
      // Merge any newer logs written by another route/worker bundle
      const newestMemTs = this.logs[0]?.ts || 0;
      const newerFromDisk = diskLogs.filter((d) => d.ts > newestMemTs);
      if (newerFromDisk.length > 0) {
        this.logs = [...newerFromDisk, ...this.logs].slice(0, 500);
      } else if (diskLogs.length > this.logs.length) {
        const seen = new Set(this.logs.map((l) => `${l.ts}:${l.step}:${l.detail}`));
        for (const d of diskLogs) {
          const key = `${d.ts}:${d.step}:${d.detail}`;
          if (!seen.has(key)) {
            this.logs.push(d);
            seen.add(key);
          }
        }
        this.logs.sort((a, b) => b.ts - a.ts);
        if (this.logs.length > 500) this.logs.length = 500;
      }
    } catch {
      // ignore disk log sync errors
    }
  }

  private log(step: string, detail: string, status: YtStepLog['status'] = 'info'): void {
    this.syncLogsFromDiskIfNeeded();
    this.currentStep = `${step}: ${detail}`;
    if (status === 'error') {
      this.lastError = detail;
    }
    this.logs.unshift({
      ts: Date.now(),
      step,
      detail,
      status,
    });
    if (this.logs.length > 500) {
      this.logs.length = 500;
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(this.getPersistedLogsPath(), JSON.stringify(this.logs.slice(0, 500)), 'utf8');
    } catch {
      // ignore disk log write errors
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const nextLock = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.actionLock;
    this.actionLock = prev.then(() => nextLock);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private getProfileDir(): string {
    const dir = path.join(DATA_DIR, 'yt-studio-chrome-profile');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async ensureXvfbDisplay(): Promise<string> {
    const display = process.env.DISPLAY || ':99';
    process.env.DISPLAY = display;
    const displayNum = display.replace(/^:/, '').split('.')[0] || '99';
    const xSocket = `/tmp/.X11-unix/X${displayNum}`;
    if (fs.existsSync(xSocket)) {
      return display;
    }
    if (fs.existsSync('/usr/bin/Xvfb')) {
      try {
        const { spawn } = await import('child_process');
        try {
          fs.mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 });
        } catch {
          // ignore
        }
        try {
          const lockFile = `/tmp/.X${displayNum}-lock`;
          if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } catch {
          // ignore
        }
        const child = spawn(
          '/usr/bin/Xvfb',
          [`:${displayNum}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac'],
          { detached: true, stdio: 'ignore' }
        );
        child.unref();
        for (let i = 0; i < 25; i++) {
          if (fs.existsSync(xSocket)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch {
        // ignore
      }
    }
    return display;
  }

  private bindContextPopupListeners(context: BrowserContext): void {
    if (this.boundContext === context) return;
    this.boundContext = context;

    const attachPageCloseListener = (p: Page) => {
      p.on('close', () => {
        if (!this.context) return;
        const remaining = this.context.pages().filter((pg) => !pg.isClosed());
        if (remaining.length > 0) {
          this.page = remaining[remaining.length - 1];
          this.manualTabSelection = false;
          this.log(
            'popup closed',
            `Popup window closed — switched back to ${this.page.url() || 'main tab'}`,
            'ok'
          );
        } else {
          this.page = null;
        }
      });
    };

    for (const existingPage of context.pages()) {
      attachPageCloseListener(existingPage);
    }

    context.on('page', async (newPage: Page) => {
      try {
        await newPage.setViewportSize(this.viewport).catch(() => {});
        await newPage.bringToFront().catch(() => {});
      } catch {
        // ignore
      }
      this.page = newPage;
      this.manualTabSelection = false;
      attachPageCloseListener(newPage);
      await newPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      this.log(
        'popup opened',
        `Switched live screen to new popup/tab: ${newPage.url() || 'loading...'}`,
        'ok'
      );
    });
  }

  private syncActivePopupPageIfNeeded(): void {
    if (!this.context) return;
    this.bindContextPopupListeners(this.context);
    const openPages = this.context.pages().filter((p) => !p.isClosed());
    if (openPages.length === 0) return;

    // If current page was closed or not in openPages, pick the latest open page
    if (!this.page || this.page.isClosed() || !openPages.includes(this.page)) {
      this.page = openPages[openPages.length - 1];
      return;
    }

    // If a Google verification / sign-in popup opened as a second tab and we haven't manually switched away,
    // automatically focus the latest popup tab so the user sees "Verify it's you" / Google login immediately!
    if (!this.manualTabSelection && openPages.length > 1) {
      const latestPage = openPages[openPages.length - 1];
      if (latestPage !== this.page) {
        this.page = latestPage;
        this.log(
          'popup active',
          `Focused popup window (${ openPages.length } tabs open): ${latestPage.url() || 'loading...'}`,
          'ok'
        );
      }
    }
  }

  async ensurePage(username = 'admin'): Promise<Page> {
    if (this.context && this.page && !this.page.isClosed()) {
      this.syncActivePopupPageIfNeeded();
      return this.page;
    }
    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      this.status = 'starting';
      const displayEnv = await this.ensureXvfbDisplay();
      const { chromium } = await import('playwright');
      const profileDir = this.getProfileDir();
      cleanStaleSingletonLocks(profileDir);

      const executablePath = resolveSystemChromePath();
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        `--window-size=${this.viewport.width},${this.viewport.height}`,
      ];

      this.log(
        'browser launching',
        `channel=chrome · mode=headed · profile=yt-studio-chrome-profile · path=${executablePath || 'system-chrome'} · display=${displayEnv}`,
        'info'
      );

      let context: BrowserContext;
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          headless: false,
          ...(executablePath ? { executablePath } : { channel: 'chrome' }),
          viewport: this.viewport,
          args,
        });
      } catch {
        context = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          viewport: this.viewport,
          args,
        });
      }

      this.context = context;
      this.bindContextPopupListeners(context);
      const pages = context.pages().filter((p) => !p.isClosed());
      const page = pages.length > 0 ? pages[pages.length - 1] : await context.newPage();
      await page.setViewportSize(this.viewport).catch(() => {});
      this.page = page;

      await this.applySavedCookiesToContext(username);

      this.status = this.assistMode ? 'assist' : 'ready';
      this.log(
        'browser launched',
        `channel=chrome · mode=headed · profile=yt-studio-chrome-profile · path=${executablePath || '/usr/bin/google-chrome'} · display=${displayEnv}`,
        'ok'
      );
      return page;
    })();

    try {
      return await this.launchPromise;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.log('browser', `Failed to launch YT Studio browser: ${msg}`, 'error');
      throw err;
    } finally {
      this.launchPromise = null;
    }
  }

  async applySavedCookiesToContext(username = 'admin'): Promise<number> {
    if (!this.context) return 0;
    const cookies = await loadDecryptedPlaywrightYtCookies(username);
    if (!cookies.length) return 0;

    // Normalize cookies for Chromium/Playwright:
    // 1. __Host- cookies MUST use `url` (without `domain`) and `path: '/'` + `secure: true`,
    //    otherwise Chromium rejects the entire addCookies batch!
    // 2. Mirror core Google/YouTube auth cookies across .youtube.com and .google.com if only present on one.
    type AddCookieParam = Parameters<BrowserContext['addCookies']>[0][number];
    const normalized: AddCookieParam[] = [];
    const seenKeys = new Set<string>();

    const pushNormalized = (c: {
      name: string;
      value: string;
      domain: string;
      path?: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: 'Strict' | 'Lax' | 'None';
    }) => {
      const cleanDomain = (c.domain || '').trim();
      if (!c.name || !cleanDomain) return;
      const isHostPrefix = c.name.startsWith('__Host-');
      const isSecurePrefix = c.name.startsWith('__Secure-') || isHostPrefix;
      const secure = isSecurePrefix ? true : Boolean(c.secure ?? true);
      const sameSite = c.sameSite === 'None' && !secure ? 'Lax' : c.sameSite;
      const validExpires =
        typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0
          ? c.expires
          : undefined;

      if (isHostPrefix) {
        const hostOnly = cleanDomain.replace(/^\./, '');
        const url = `https://${hostOnly}/`;
        const key = `${c.name}|url:${url}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        normalized.push({
          name: c.name,
          value: c.value,
          url,
          secure: true,
          httpOnly: Boolean(c.httpOnly),
          ...(validExpires ? { expires: validExpires } : {}),
          ...(sameSite ? { sameSite } : {}),
        });
      } else {
        const cookiePath = c.path || '/';
        const key = `${c.name}|dom:${cleanDomain}|path:${cookiePath}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        normalized.push({
          name: c.name,
          value: c.value,
          domain: cleanDomain,
          path: cookiePath,
          secure,
          httpOnly: Boolean(c.httpOnly),
          ...(validExpires ? { expires: validExpires } : {}),
          ...(sameSite ? { sameSite } : {}),
        });
      }
    };

    const MIRROR_AUTH_COOKIES = new Set([
      'SID',
      'HSID',
      'SSID',
      'APISID',
      'SAPISID',
      '__Secure-1PSID',
      '__Secure-3PSID',
      '__Secure-1PAPISID',
      '__Secure-3PAPISID',
      '__Secure-1PSIDTS',
      '__Secure-3PSIDTS',
      '__Secure-1PSIDCC',
      '__Secure-3PSIDCC',
      'SIDCC',
      'LOGIN_INFO',
    ]);

    for (const c of cookies) {
      pushNormalized(c);
      if (MIRROR_AUTH_COOKIES.has(c.name)) {
        if (c.domain.includes('google.com')) {
          pushNormalized({ ...c, domain: '.youtube.com', path: '/' });
        } else if (c.domain.includes('youtube.com')) {
          pushNormalized({ ...c, domain: '.google.com', path: '/' });
        }
      }
    }

    try {
      await this.context.addCookies(normalized);
      this.log('cookies', `Applied ${normalized.length} saved YouTube/Google cookies`, 'ok');
      return normalized.length;
    } catch {
      // Fallback: add cookies individually so one rejected cookie never blocks all other valid cookies
      let applied = 0;
      for (const singleCookie of normalized) {
        try {
          await this.context.addCookies([singleCookie]);
          applied++;
        } catch {
          // skip single invalid cookie
        }
      }
      if (applied > 0) {
        this.log(
          'cookies',
          `Applied ${applied}/${normalized.length} saved YouTube/Google cookies (per-cookie fallback)`,
          'ok'
        );
      } else {
        this.log('cookies', 'Could not apply saved YouTube cookies (0 valid cookies accepted)', 'warn');
      }
      return applied;
    }
  }

  async saveSessionFromContext(username = 'admin'): Promise<{ savedCount: number }> {
    const page = await this.ensurePage(username);
    if (!this.context) throw new Error('Browser context not active');

    const allCookies = await this.context.cookies([
      'https://studio.youtube.com',
      'https://www.youtube.com',
      'https://youtube.com',
      'https://accounts.google.com',
      'https://myaccount.google.com',
    ]);

    const filtered = allCookies.filter((c) =>
      c.domain.includes('youtube.com') ||
      c.domain.includes('google.com')
    );

    if (filtered.length === 0) {
      throw new Error('No YouTube/Google cookies found in live browser session.');
    }

    const res = await saveUserYtCookies(username, JSON.stringify(filtered));
    const ch = await this.detectCurrentChannel(page).catch(() => ({
      channelId: null,
      channelHandle: null,
    }));

    const cfg = await loadStudioUserConfig(username);
    await saveStudioUserConfig(username, {
      ytLastLoginStatus: 'logged_in',
      ytLastLoginTestedAt: Date.now(),
      ytChannelId: ch.channelId || cfg.ytChannelId || null,
      ytChannelHandle: ch.channelHandle || cfg.ytChannelHandle || null,
    });

    if (ch.channelId) this.channelId = ch.channelId;
    if (ch.channelHandle) this.channelHandle = ch.channelHandle;

    this.log(
      'session saved',
      `Saved ${res.count} cookies from live YT Studio browser${ch.channelHandle ? ` (${ch.channelHandle})` : ''}`,
      'ok'
    );
    return { savedCount: res.count };
  }

  async detectCurrentChannel(page: Page): Promise<{ channelId: string | null; channelHandle: string | null }> {
    const url = page.url();
    let channelId: string | null = null;
    let channelHandle: string | null = null;

    const urlMatch = url.match(/\/channel\/(UC[a-zA-Z0-9_-]{16,})/);
    if (urlMatch) {
      channelId = urlMatch[1];
    }

    try {
      const extracted = await page.evaluate(() => {
        let cid: string | null = null;
        let handle: string | null = null;

        const m = window.location.href.match(/\/channel\/(UC[a-zA-Z0-9_-]{16,})/);
        if (m) cid = m[1];

        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const txt = s.textContent || '';
          if (!cid) {
            const cm = txt.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{16,})"/);
            if (cm) cid = cm[1];
          }
          if (!handle) {
            const hm = txt.match(/"canonicalBaseUrl"\s*:\s*"\/(@[a-zA-Z0-9_.-]+)"/) ||
              txt.match(/"vanityChannelUrl"\s*:\s*"https?:\/\/[^"]+\/(@[a-zA-Z0-9_.-]+)"/);
            if (hm) handle = hm[1];
          }
        }

        if (!handle) {
          const textBody = document.body?.innerText || '';
          const hm2 = textBody.match(/(@[a-zA-Z0-9_.-]{3,35})/);
          if (hm2) handle = hm2[1];
        }

        const nameEl = document.querySelector('#entity-name, ytcp-entity-snapshot #entity-name, #channel-title');
        const entityName = nameEl?.textContent?.trim() || null;
        if (!handle && entityName) {
          handle = entityName;
        }

        return { cid, handle };
      });

      if (extracted.cid) channelId = extracted.cid;
      if (extracted.handle) channelHandle = extracted.handle;
    } catch {
      // ignore evaluate errors
    }

    if (channelId) this.channelId = channelId;
    if (channelHandle) this.channelHandle = channelHandle;
    return { channelId, channelHandle };
  }

  async verifyOrLockChannel(page: Page, username = 'admin'): Promise<{ channelId: string | null; channelHandle: string | null }> {
    const detected = await this.detectCurrentChannel(page);
    const cfg = await loadStudioUserConfig(username);

    if (
      detected.channelId &&
      (cfg.ytChannelId !== detected.channelId || (detected.channelHandle && cfg.ytChannelHandle !== detected.channelHandle))
    ) {
      await saveStudioUserConfig(username, {
        ytChannelId: detected.channelId,
        ytChannelHandle: detected.channelHandle || cfg.ytChannelHandle || null,
        ytLastLoginStatus: 'logged_in',
        ytLastLoginTestedAt: Date.now(),
      });
      this.log(
        'channel lock',
        `Locked YT Studio channel to ${detected.channelHandle || detected.channelId}`,
        'ok'
      );
    } else if (!cfg.ytChannelId && (detected.channelId || detected.channelHandle)) {
      await saveStudioUserConfig(username, {
        ytChannelId: detected.channelId || cfg.ytChannelId,
        ytChannelHandle: detected.channelHandle || cfg.ytChannelHandle,
      });
      this.log(
        'channel lock',
        `Locked YT Studio channel to ${detected.channelHandle || detected.channelId}`,
        'ok'
      );
    }

    return {
      channelId: detected.channelId || cfg.ytChannelId || null,
      channelHandle: detected.channelHandle || cfg.ytChannelHandle || null,
    };
  }

  private async dumpFailureScreenshot(page: Page | null, tag: string): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const fileName = `yt-studio-fail-${tag}-${Date.now()}.png`;
      const fullPath = path.join(DATA_DIR, fileName);
      await page.screenshot({ path: fullPath, fullPage: false });
      this.log('diagnostic', `Saved diagnostic screenshot: data/${fileName}`, 'warn');
      return fullPath;
    } catch {
      return null;
    }
  }

  async testLogin(username = 'admin'): Promise<{
    loggedIn: boolean;
    url: string;
    channelId: string | null;
    channelHandle: string | null;
    message: string;
  }> {
    const page = await this.ensurePage(username);
    await this.applySavedCookiesToContext(username);

    const curUrl = page.url();
    const alreadyOnStudioChannel =
      curUrl.startsWith('https://studio.youtube.com/channel/UC') &&
      !curUrl.includes('accounts.google.com');

    if (!alreadyOnStudioChannel) {
      this.log('test login', 'Navigating to https://studio.youtube.com ...', 'info');
      await page
        .goto('https://studio.youtube.com', {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        })
        .catch(() => {});
    }

    // Wait up to 12 seconds for passive redirects (CheckCookie / AccountChooser / studio.youtube.com/channel/UC...)
    const waitDeadline = Date.now() + 12_000;
    while (Date.now() < waitDeadline) {
      const u = page.url();
      if (u.startsWith('https://studio.youtube.com/channel/UC')) {
        break;
      }
      // If on Google AccountChooser with an already signed-in account row (not signed out), click it automatically
      if (u.includes('accounts.google.com') && (u.includes('AccountChooser') || u.includes('signin/v2/identifier') === false)) {
        const clickedChooser = await page
          .evaluate(() => {
            const rows = Array.from(
              document.querySelectorAll('div[data-identifier], li [data-identifier]')
            ) as HTMLElement[];
            for (const r of rows) {
              const txt = (r.innerText || r.textContent || '').toLowerCase();
              if (!txt.includes('signed out') && !txt.includes('use another account')) {
                r.click();
                return true;
              }
            }
            return false;
          })
          .catch(() => false);
        if (clickedChooser) {
          this.log('test login', 'Clicked signed-in Google account in AccountChooser...', 'info');
          await page.waitForTimeout(2500);
          continue;
        }
      }
      if (u.startsWith('https://studio.youtube.com') && !u.includes('accounts.google.com')) {
        const hasStudioUi = await page
          .locator('#create-icon, ytcp-entity-snapshot, a#menu-paper-icon-item-1, ytcp-video-row')
          .first()
          .isVisible()
          .catch(() => false);
        if (hasStudioUi) break;
      }
      await page.waitForTimeout(1000);
    }

    const url = page.url();
    const isAuthWall =
      url.includes('accounts.google.com') ||
      url.includes('ServiceLogin') ||
      url.includes('/signin');

    if (isAuthWall) {
      await saveStudioUserConfig(username, {
        ytLastLoginStatus: 'logged_out',
        ytLastLoginTestedAt: Date.now(),
      });
      this.log('test login', `Redirected to Google Sign-In (${url})`, 'error');
      return {
        loggedIn: false,
        url,
        channelId: null,
        channelHandle: null,
        message: 'Not logged in — redirected to Google Sign-In. Use Login Assist or paste fresh cookies.',
      };
    }

    const ch = await this.verifyOrLockChannel(page, username);
    // Also persist live session cookies back to store so any refreshed SIDCC / PSIDTS tokens are saved
    await this.saveSessionFromContext(username).catch(() => {});

    await saveStudioUserConfig(username, {
      ytLastLoginStatus: 'logged_in',
      ytLastLoginTestedAt: Date.now(),
      ytChannelId: ch.channelId,
      ytChannelHandle: ch.channelHandle,
    });

    this.log(
      'test login',
      `Logged in to YouTube Studio (${ch.channelHandle || ch.channelId || url})`,
      'ok'
    );

    return {
      loggedIn: true,
      url,
      channelId: ch.channelId,
      channelHandle: ch.channelHandle,
      message: `Logged in to YouTube Studio${ch.channelHandle ? ` as ${ch.channelHandle}` : ''}${ch.channelId ? ` (${ch.channelId})` : ''}`,
    };
  }

  /**
   * Immediately dismiss any post-upload "Video processing" / "Checks complete. Claimed content found."
   * / "Video published" / leftover upload dialogs so the browser NEVER waits on or gets stuck on a modal.
   */
  async dismissAllUploadDialogs(page: Page): Promise<boolean> {
    if (!page || page.isClosed()) return false;
    let dismissedAny = false;

    for (let pass = 0; pass < 3; pass++) {
      // 1. Direct DOM click on any visible Close button inside post-upload / processing dialogs
      const domClicked = await page
        .evaluate(() => {
          const isVisibleEl = (el: Element | null): el is HTMLElement => {
            if (!el || !(el instanceof HTMLElement)) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0'
            );
          };

          const dialogSelectors = [
            'ytcp-uploads-still-processing-dialog',
            'ytcp-video-share-dialog',
            'tp-yt-paper-dialog[aria-modal="true"]',
            'tp-yt-paper-dialog',
            'ytcp-dialog',
            'ytcp-uploads-dialog',
            'ytcp-uploads-mini-indicator',
          ];

          for (const dSel of dialogSelectors) {
            const dialogs = Array.from(document.querySelectorAll(dSel));
            for (const dlg of dialogs) {
              if (!isVisibleEl(dlg)) continue;
              const txt = (dlg.textContent || '').toLowerCase();
              const isPostUploadModal =
                dSel === 'ytcp-uploads-still-processing-dialog' ||
                dSel === 'ytcp-video-share-dialog' ||
                txt.includes('video processing') ||
                txt.includes('finish processing before your video is unlisted') ||
                txt.includes('claimed content') ||
                txt.includes('checks complete') ||
                txt.includes('video published') ||
                txt.includes('video link');

              const closeCandidates = Array.from(
                dlg.querySelectorAll(
                  '#close-button, ytcp-button#close-button, #close-icon-button, ytcp-icon-button#close-icon-button, button[aria-label="Close"], ytcp-icon-button[aria-label="Close"], ytcp-button, button'
                )
              );
              for (const btn of closeCandidates) {
                if (!isVisibleEl(btn)) continue;
                const bTxt = (btn.textContent || '').trim().toLowerCase();
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const id = (btn.getAttribute('id') || '').toLowerCase();
                if (
                  id === 'close-button' ||
                  id === 'close-icon-button' ||
                  bTxt === 'close' ||
                  aria === 'close' ||
                  (isPostUploadModal && bTxt.includes('close'))
                ) {
                  btn.click();
                  const innerBtn = btn.querySelector('button, tp-yt-iron-icon');
                  if (innerBtn instanceof HTMLElement) innerBtn.click();
                  return true;
                }
              }
            }
          }
          return false;
        })
        .catch(() => false);

      if (domClicked) {
        dismissedAny = true;
        await page.waitForTimeout(450);
      }

      // 2. Playwright locator fallback iterating over ALL matching close buttons (not .first()!)
      const closeSelectors = [
        'ytcp-uploads-still-processing-dialog #close-button',
        'ytcp-uploads-still-processing-dialog ytcp-button:has-text("Close")',
        'tp-yt-paper-dialog:has-text("Video processing") #close-button',
        'tp-yt-paper-dialog:has-text("Video processing") ytcp-button:has-text("Close")',
        'tp-yt-paper-dialog:has-text("Video processing") button:has-text("Close")',
        'tp-yt-paper-dialog:has-text("Claimed content") ytcp-button:has-text("Close")',
        'ytcp-video-share-dialog #close-button',
        'ytcp-video-share-dialog ytcp-button:has-text("Close")',
        'ytcp-uploads-dialog #close-icon-button',
        'ytcp-uploads-dialog #close-button',
        'ytcp-uploads-mini-indicator #close-button',
        'tp-yt-paper-dialog ytcp-button:has-text("Close")',
        'tp-yt-paper-dialog button[aria-label="Close"]',
        'ytcp-dialog #close-button',
      ];

      let clickedInPass = false;
      for (const sel of closeSelectors) {
        const allBtns = await page.locator(sel).all().catch(() => []);
        for (const btn of allBtns) {
          if (await btn.isVisible().catch(() => false)) {
            await btn.click({ timeout: 2500, force: true }).catch(() => {});
            dismissedAny = true;
            clickedInPass = true;
            await page.waitForTimeout(450);
          }
        }
      }

      // Check if any dialog or iron-overlay-backdrop is still open
      const stillOpen = await page
        .locator(
          'ytcp-uploads-still-processing-dialog, tp-yt-paper-dialog:has-text("Video processing"), ytcp-video-share-dialog, ytcp-uploads-dialog[opened], tp-yt-iron-overlay-backdrop.opened'
        )
        .first()
        .isVisible()
        .catch(() => false);

      if (!stillOpen && !clickedInPass) {
        break;
      }
      if (stillOpen) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(450);
      }
    }

    // Ensure no orphaned <tp-yt-iron-overlay-backdrop class="opened"> remains to intercept pointer events on Create
    // IMPORTANT: Never set display:none on ytcp-uploads-dialog itself because YouTube Studio reuses that singleton element for the next upload!
    await page
      .evaluate(() => {
        const uploadDlg = document.querySelector('ytcp-uploads-dialog');
        if (uploadDlg instanceof HTMLElement) {
          uploadDlg.style.removeProperty('display');
          uploadDlg.style.removeProperty('pointer-events');
        }
        const postDialogs = Array.from(
          document.querySelectorAll(
            'ytcp-uploads-still-processing-dialog, ytcp-video-share-dialog'
          )
        );
        for (const dlg of postDialogs) {
          const closeBtn = dlg.querySelector(
            'ytcp-button#close-button button, #close-button button, #close-button, button[aria-label="Close"], ytcp-icon-button[aria-label="Close"]'
          ) as HTMLElement | null;
          if (closeBtn) {
            try {
              closeBtn.click();
            } catch {
              // ignore
            }
          }
          dlg.removeAttribute('opened');
        }
        const openModal = document.querySelector(
          'ytcp-uploads-dialog[opened], ytcp-uploads-still-processing-dialog[opened], tp-yt-paper-dialog[aria-modal="true"][opened]'
        );
        if (!openModal) {
          const backdrops = Array.from(
            document.querySelectorAll('tp-yt-iron-overlay-backdrop.opened, tp-yt-iron-overlay-backdrop[opened]')
          );
          for (const bd of backdrops) {
            bd.classList.remove('opened');
            bd.removeAttribute('opened');
            if (bd instanceof HTMLElement) {
              bd.style.display = 'none';
              bd.style.pointerEvents = 'none';
            }
          }
        }
      })
      .catch(() => {});

    if (dismissedAny) {
      this.log(
        'dialog closed',
        'Closed post-upload "Video processing" popup immediately (no waiting on modal)',
        'ok'
      );
    }
    return dismissedAny;
  }

  /**
   * Detect if YouTube Studio is showing the "Daily upload limit reached" error on the page or inside any dialog/toast.
   */
  async detectDailyUploadLimitOnPage(page: Page): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    try {
      return await page.evaluate(() => {
        const limitRe =
          /(daily\s+upload\s+limit\s+reached|you\s+have\s+reached\s+your\s+daily\s+upload\s+limit|upload\s+limit\s+reached|can\s+upload\s+more\s+videos\s+in\s+24\s+hours|limit\s+of\s+how\s+many\s+videos\s+you\s+can\s+upload|too\s+many\s+videos\s+in\s+a\s+short\s+time)/i;
        const containers = Array.from(
          document.querySelectorAll(
            'ytcp-uploads-dialog, tp-yt-paper-dialog, ytcp-dialog, tp-yt-paper-toast, ytcp-Toast, [role="alert"], [role="dialog"], body'
          )
        );
        for (const el of containers) {
          if (!(el instanceof HTMLElement)) continue;
          const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          const m = txt.match(limitRe);
          if (m) {
            return m[0];
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  private async acquireUploadPage(username = 'admin'): Promise<Page> {
    this.ensureInternalCollections();
    const basePage = await this.ensurePage(username);
    if (!this.context) return basePage;

    // Close any stray extra non-auth tabs so uploads always happen cleanly on the single main tab without backdrop collisions
    const openPages = this.context.pages().filter((p) => !p.isClosed());
    if (openPages.length > 1 && !this.assistMode) {
      for (let i = openPages.length - 1; i >= 1; i--) {
        const extra = openPages[i];
        if (!extra.url().includes('accounts.google.com')) {
          await extra.close().catch(() => {});
        }
      }
    }

    const activePages = this.context
      .pages()
      .filter((p) => !p.isClosed() && !p.url().includes('accounts.google.com'));
    const chosen = activePages[0] || basePage;
    this.busyUploadPages.add(chosen);
    this.page = chosen;
    return chosen;
  }

  private async releaseUploadPage(uploadPage: Page): Promise<void> {
    this.ensureInternalCollections();
    this.busyUploadPages.delete(uploadPage);
  }

  /**
   * Extract the `https://youtu.be/<id>` share URL strictly from the active upload dialog
   * (never from the background Content table!), ignoring any video IDs in `ignoreVideoIds`.
   */
  private async extractShareUrlFromUploadModal(
    page: Page,
    ignoreVideoIds?: Set<string>
  ): Promise<string | null> {
    try {
      const ignoreList = ignoreVideoIds ? Array.from(ignoreVideoIds) : [];
      return await page.evaluate((ignoredIds: string[]) => {
        const ignoreSet = new Set(ignoredIds);
        const extractId = (rawUrl: string): string | null => {
          const m =
            rawUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
            rawUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
            rawUrl.match(/shorts\/([a-zA-Z0-9_-]{11})/) ||
            rawUrl.match(/\/video\/([a-zA-Z0-9_-]{11})/);
          return m ? m[1] : null;
        };

        // Strictly search ONLY inside open upload / processing / share dialogs, NEVER in the background Content table!
        const dialogRoots = Array.from(
          document.querySelectorAll(
            'ytcp-uploads-dialog, ytcp-video-info, ytcp-uploads-still-processing-dialog, ytcp-video-share-dialog'
          )
        ).filter((el) => {
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        });

        for (const root of dialogRoots) {
          // 1. Direct youtu.be or watch links inside the dialog
          const linkEls = Array.from(
            root.querySelectorAll(
              'a.style-scope.ytcp-video-info, a[href*="youtu.be/"], a[href*="youtube.com/watch"], a[href*="youtube.com/shorts/"], a[href*="/video/"]'
            )
          );
          for (const el of linkEls) {
            const href =
              (el as HTMLAnchorElement).href ||
              (el as HTMLAnchorElement).getAttribute('href') ||
              el.textContent ||
              '';
            const vid = extractId(href);
            if (vid && !ignoreSet.has(vid)) {
              return `https://youtu.be/${vid}`;
            }
          }

          // 2. Plain text match for https://youtu.be/<11-char-id> inside the dialog
          const text = (root as HTMLElement).innerText || root.textContent || '';
          const matches = Array.from(text.matchAll(/https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/g));
          for (const m of matches) {
            if (m[1] && !ignoreSet.has(m[1])) {
              return `https://youtu.be/${m[1]}`;
            }
          }
        }
        return null;
      }, ignoreList);
    } catch {
      return null;
    }
  }

  async uploadWindowClip(opts: {
    clipPath: string;
    scanId: string;
    windowNumber: number;
    visibility?: 'unlisted' | 'private';
    username?: string;
    forceUpload?: boolean;
    onProgress?: (stage: string) => void;
  }): Promise<{ ytUrl: string; ytVideoId: string; reused: boolean }> {
    this.ensureInternalCollections();
    const {
      clipPath,
      scanId,
      windowNumber,
      visibility = 'unlisted',
      username = 'admin',
      forceUpload = false,
      onProgress,
    } = opts;

    if (!forceUpload) {
      const scanPrefix = scanId ? scanId.slice(0, 8).toLowerCase() : '';
      const existing =
        readClipYtSidecar(clipPath) ||
        readClipYtSidecar(scanId, windowNumber);
      const contentMatch = this.contentProgress?.items?.find(
        (it) =>
          it.windowNumber === windowNumber &&
          (!it.scanPrefix || !scanPrefix || it.scanPrefix.toLowerCase() === scanPrefix)
      );
      const cachedUrl = existing?.ytUrl || contentMatch?.ytUrl;
      const cachedId = existing?.ytVideoId || contentMatch?.videoId;
      if (cachedUrl && cachedId && !existing?.ytDeleted) {
        this.uploadedVideoIdsInSession.add(cachedId);
        if (!existing?.ytUrl) {
          saveClipYtSidecar(clipPath, {
            scanId,
            windowNumber,
            ytUrl: cachedUrl,
            ytVideoId: cachedId,
            ytUploadedAt: Date.now(),
            ytDeleted: false,
          });
        }
        this.log(
          'sidecar hit',
          `Reusing cached YouTube link for W${String(windowNumber).padStart(2, '0')}: ${cachedUrl}`,
          'ok'
        );
        onProgress?.('link ready');
        return {
          ytUrl: cachedUrl,
          ytVideoId: cachedId,
          reused: true,
        };
      }
    }

    // Deduplicate concurrent upload requests for the exact same clipPath
    const inFlight = this.inFlightClipUploads.get(clipPath);
    if (inFlight && !forceUpload) {
      return inFlight;
    }

    const runUploadPromise = this.withLock(async (): Promise<{ ytUrl: string; ytVideoId: string; reused: boolean }> => {
      if (!fs.existsSync(clipPath)) {
        throw new Error(`Clip file not found at ${clipPath}`);
      }

      const title = `cmt-${scanId.slice(0, 8)}-w${windowNumber}`;
      let lastErr: Error | null = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        const uploadPage = await this.acquireUploadPage(username);
        try {
          this.status = 'uploading';
          onProgress?.('uploading to YT');

          // Navigate to channel videos page (without ?d=ud so YouTube doesn't auto-open an unwanted backdrop)
          const targetStudioUrl = this.channelId
            ? `https://studio.youtube.com/channel/${this.channelId}/videos/upload?filter=%5B%5D`
            : 'https://studio.youtube.com';

          if (!uploadPage.url().startsWith('https://studio.youtube.com')) {
            await uploadPage.goto(targetStudioUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 45000,
            });
            await uploadPage.waitForTimeout(2500);
          } else {
            await uploadPage.bringToFront().catch(() => {});
          }

          if (uploadPage.url().includes('accounts.google.com')) {
            throw new Error('YT Studio session logged out — redirected to accounts.google.com');
          }

          await this.verifyOrLockChannel(uploadPage, username);

          // If any previous upload's ytcp-uploads-dialog is still open on screen, click its visible Save button first, then dismiss all dialogs
          const hadVisibleUploadModal = await uploadPage
            .evaluate(() => {
              const isVis = (el: Element | null): el is HTMLElement => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden';
              };
              const dlgs = Array.from(document.querySelectorAll('ytcp-uploads-dialog'));
              for (const dlg of dlgs) {
                if (!isVis(dlg)) continue;
                const doneBtns = Array.from(
                  dlg.querySelectorAll('#done-button button, #done-button, ytcp-button#done-button')
                );
                for (const b of doneBtns) {
                  if (isVis(b)) {
                    b.click();
                  }
                }
                return true;
              }
              return false;
            })
            .catch(() => false);

          if (hadVisibleUploadModal) {
            await uploadPage.waitForTimeout(2000);
          }

          // Dismiss any leftover "Video processing" or upload dialog and clear any backdrop before starting, then wait 2s
          await this.dismissAllUploadDialogs(uploadPage);
          await uploadPage.waitForTimeout(2000);

          // Check if ANY ytcp-uploads-dialog is STILL visibly open on a previous video's metadata/visibility step; if so, reload clean Content page
          const stillHasStuckUploadModal = await uploadPage
            .evaluate(() => {
              const isVis = (el: Element | null): boolean => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
              };
              return Array.from(
                document.querySelectorAll(
                  'ytcp-uploads-dialog #title-textarea, ytcp-uploads-dialog #done-button, ytcp-uploads-dialog #next-button'
                )
              ).some((el) => isVis(el));
            })
            .catch(() => false);

          if (stillHasStuckUploadModal) {
            const cleanUrl = this.channelId
              ? `https://studio.youtube.com/channel/${this.channelId}/videos/upload?filter=%5B%5D`
              : 'https://studio.youtube.com';
            await uploadPage.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
            await uploadPage.waitForTimeout(2500);
          }

          // Record any stale video IDs currently in the modal or already uploaded in this session so we never reuse an old URL
          const ignoreVideoIds = new Set<string>(this.uploadedVideoIdsInSession);
          const preExistingModalUrl = await this.extractShareUrlFromUploadModal(uploadPage);
          if (preExistingModalUrl) {
            const preMatch = preExistingModalUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
            if (preMatch?.[1]) ignoreVideoIds.add(preMatch[1]);
          }

          // Before opening the upload picker, check if this window's video ("cmt-<prefix>-w<N>") is ALREADY on the Content table
          if (!forceUpload) {
            const existingOnTable = await uploadPage
              .evaluate((expectedTitle: string) => {
                const rows = Array.from(document.querySelectorAll('ytcp-video-row'));
                for (const row of rows) {
                  const titleEl = row.querySelector('#video-title, a#video-title') as HTMLElement | null;
                  const rowTitle = (titleEl?.innerText || titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
                  if (rowTitle.toLowerCase() !== expectedTitle.toLowerCase()) continue;
                  const rowTxt = ((row as HTMLElement).innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
                  const visCell = row.querySelector(
                    '#visibility-label, ytcp-video-list-cell-visibility, .tablecell-visibility'
                  ) as HTMLElement | null;
                  const visTxt = (visCell?.innerText || visCell?.textContent || '').replace(/\s+/g, ' ').trim();
                  const isDraftOrPrivate =
                    /\b(draft|edit\s+draft|private)\b/i.test(visTxt) ||
                    /\bedit\s+draft\b/i.test(rowTxt);
                  const anchors = Array.from(row.querySelectorAll('a[href]'));
                  for (const a of anchors) {
                    const href = a.getAttribute('href') || '';
                    const m =
                      href.match(/\/video\/([a-zA-Z0-9_-]{11})/) ||
                      href.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
                      href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
                    if (m?.[1]) {
                      return {
                        videoId: m[1],
                        ytUrl: `https://youtu.be/${m[1]}`,
                        isDraftOrPrivate,
                      };
                    }
                  }
                }
                return null;
              }, title)
              .catch(() => null);

            if (existingOnTable?.ytUrl && existingOnTable.videoId) {
              if (existingOnTable.isDraftOrPrivate && visibility === 'unlisted') {
                this.log(
                  'fix draft/private',
                  `[W${String(windowNumber).padStart(2, '0')}] Existing video "${title}" is Draft/Private -> converting to Unlisted...`,
                  'warn'
                );
                await this.convertVideoRowToUnlistedOnContentPage(uploadPage, {
                  videoId: existingOnTable.videoId,
                  title,
                  windowNumber,
                  scanPrefix,
                }).catch(() => {});
              }
              this.uploadedVideoIdsInSession.add(existingOnTable.videoId);
              saveClipYtSidecar(clipPath, {
                scanId,
                windowNumber,
                ytUrl: existingOnTable.ytUrl,
                ytVideoId: existingOnTable.videoId,
                ytUploadedAt: Date.now(),
                ytDeleted: false,
              });
              onProgress?.('link ready');
              this.log(
                'already uploaded',
                `[W${String(windowNumber).padStart(2, '0')}] Video "${title}" already on channel -> ${existingOnTable.ytUrl} (Unlisted verified, skipping duplicate upload)`,
                'ok'
              );
              return {
                ytUrl: existingOnTable.ytUrl,
                ytVideoId: existingOnTable.videoId,
                reused: true,
              };
            }
          }

          this.log(
            'upload start',
            `[W${String(windowNumber).padStart(2, '0')}] Uploading ${path.basename(clipPath)} as "${title}" (attempt ${attempt}/2)`,
            'info'
          );

          // Step 1: Click Create -> Upload videos (using visible element matching, with 2s waits after each click)
          let fileInput = uploadPage
            .locator('ytcp-uploads-file-picker input[type="file"], input[type="file"][name="Filedata"]')
            .first();
          if (!(await fileInput.count())) {
            await this.dismissAllUploadDialogs(uploadPage);
            const createSelectors = [
              '#create-icon',
              'ytcp-button#create-icon',
              'button[aria-label="Create"]',
              'ytcp-icon-button[aria-label="Create"]',
              'button:has-text("Create")',
            ];
            let clickedCreate = false;
            for (const sel of createSelectors) {
              const allLocs = await uploadPage.locator(sel).all().catch(() => []);
              for (const loc of allLocs) {
                if (await loc.isVisible().catch(() => false)) {
                  await loc.click({ timeout: 8000 }).catch(() => {});
                  clickedCreate = true;
                  break;
                }
              }
              if (clickedCreate) break;
            }
            // Wait 2 seconds after clicking Create
            await uploadPage.waitForTimeout(2000);

            if (!clickedCreate) {
              const directUploadBtns = await uploadPage
                .locator('#upload-icon, ytcp-button#upload-icon, button[aria-label="Upload videos"]')
                .all()
                .catch(() => []);
              for (const btn of directUploadBtns) {
                if (await btn.isVisible().catch(() => false)) {
                  await btn.click({ timeout: 8000 }).catch(() => {});
                  await uploadPage.waitForTimeout(2000);
                  break;
                }
              }
            } else {
              const uploadMenuSelectors = [
                'tp-yt-paper-item#text-item-0',
                'tp-yt-paper-item:has-text("Upload videos")',
                'ytcp-ve:has-text("Upload videos")',
                '[role="menuitem"]:has-text("Upload videos")',
              ];
              let clickedMenu = false;
              for (const sel of uploadMenuSelectors) {
                const items = await uploadPage.locator(sel).all().catch(() => []);
                for (const item of items) {
                  if (await item.isVisible().catch(() => false)) {
                    await item.click({ timeout: 8000 }).catch(() => {});
                    clickedMenu = true;
                    break;
                  }
                }
                if (clickedMenu) break;
              }
              // Wait 2 seconds after clicking "Upload videos"
              await uploadPage.waitForTimeout(2000);
            }

            // Check if "Verify it's you" dialog popped up when clicking Upload videos
            const verifyPopupVisible = await uploadPage
              .locator('tp-yt-paper-dialog:has-text("Verify it\'s you"), ytcp-verify-user-dialog')
              .first()
              .isVisible()
              .catch(() => false);
            if (verifyPopupVisible) {
              this.log(
                'verify required',
                'YouTube Studio displayed "Verify it\'s you" dialog — clicking Next and switching to verification popup...',
                'warn'
              );
              await this.clickVerifyNext(username).catch(() => {});
            }

            fileInput = uploadPage
              .locator('input[type="file"][name="Filedata"], ytcp-uploads-file-picker input[type="file"], input[type="file"]')
              .first();
          }

          // Fallback: if fileInput is still not attached after clicking Create -> Upload videos, navigate directly to ?d=ud upload URL
          const attachedFast = await fileInput
            .waitFor({ state: 'attached', timeout: 8000 })
            .then(() => true)
            .catch(() => false);
          if (!attachedFast && this.channelId) {
            const directUploadUrl = `https://studio.youtube.com/channel/${this.channelId}/videos/upload?d=ud`;
            this.log('upload reopen', `Re-opening direct upload dialog (${directUploadUrl})...`, 'info');
            await uploadPage
              .goto(directUploadUrl, { waitUntil: 'domcontentloaded', timeout: 35000 })
              .catch(() => {});
            await uploadPage.waitForTimeout(2500);
            fileInput = uploadPage
              .locator('input[type="file"][name="Filedata"], ytcp-uploads-file-picker input[type="file"], input[type="file"]')
              .first();
          }

          await fileInput.waitFor({ state: 'attached', timeout: 15000 });
          await fileInput.setInputFiles(clipPath);
          this.log('upload file', `Attached ${path.basename(clipPath)} to YT Studio file picker`, 'info');

          // Wait 2.5 seconds after attaching file so upload dialog & default filename initialization complete
          await uploadPage.waitForTimeout(2500);

          // Wait for a VISIBLE title textbox inside ytcp-uploads-dialog (never rely on .first() which can match a hidden element!)
          let titleVisible = false;
          const titleWaitDeadline = Date.now() + 35_000;
          while (Date.now() < titleWaitDeadline) {
            titleVisible = await uploadPage
              .evaluate(() => {
                const isVis = (el: Element | null): boolean => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 20 && r.height > 15 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                const candidates = Array.from(
                  document.querySelectorAll(
                    'ytcp-uploads-dialog #title-textarea #textbox, ytcp-social-suggestions-textbox#title-textarea #textbox, #title-textarea #textbox, ytcp-uploads-dialog div#textbox[aria-label*="Add a title"]'
                  )
                );
                return candidates.some((el) => isVis(el));
              })
              .catch(() => false);
            if (titleVisible) break;
            await uploadPage.waitForTimeout(1000);
          }

          if (!titleVisible) {
            throw new Error('Timed out waiting for visible YouTube Studio title textbox (#title-textarea #textbox)');
          }

          // Wait 2 seconds after details modal opens so YouTube Studio's default filename write finishes before we overwrite it
          await uploadPage.waitForTimeout(2000);

          // Step 2: Set title on the VISIBLE #title-textarea #textbox and verify it equals `title` (up to 4 retries)
          for (let titleTry = 1; titleTry <= 4; titleTry++) {
            const boxCoords = await uploadPage
              .evaluate(() => {
                const isVis = (el: Element | null): el is HTMLElement => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 20 && r.height > 15 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                const tbs = Array.from(
                  document.querySelectorAll(
                    'ytcp-uploads-dialog #title-textarea #textbox, ytcp-social-suggestions-textbox#title-textarea #textbox, #title-textarea #textbox, ytcp-uploads-dialog div#textbox[aria-label*="Add a title"]'
                  )
                );
                const visTb = tbs.find((el) => isVis(el)) as HTMLElement | undefined;
                if (!visTb) return null;
                visTb.scrollIntoView({ block: 'center' });
                const r = visTb.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              })
              .catch(() => null);

            if (boxCoords) {
              await uploadPage.mouse.click(boxCoords.x, boxCoords.y).catch(() => {});
              await uploadPage.waitForTimeout(250);
              await uploadPage.keyboard.press('Control+A').catch(() => {});
              await uploadPage.keyboard.press('Backspace').catch(() => {});
              await uploadPage.keyboard.type(title, { delay: 12 }).catch(() => {});
            }

            const titleVerified = await uploadPage
              .evaluate((newTitle: string) => {
                const isVis = (el: Element | null): el is HTMLElement => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 20 && r.height > 15 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                const tbs = Array.from(
                  document.querySelectorAll(
                    'ytcp-uploads-dialog #title-textarea #textbox, ytcp-social-suggestions-textbox#title-textarea #textbox, #title-textarea #textbox, ytcp-uploads-dialog div#textbox[aria-label*="Add a title"]'
                  )
                );
                const visTb = tbs.find((el) => isVis(el)) as HTMLElement | undefined;
                if (!visTb) return false;
                if ((visTb.textContent || '').trim() !== newTitle) {
                  visTb.focus();
                  document.execCommand('selectAll', false, undefined);
                  document.execCommand('insertText', false, newTitle);
                  if ((visTb.textContent || '').trim() !== newTitle) {
                    visTb.textContent = newTitle;
                  }
                  visTb.dispatchEvent(new InputEvent('input', { bubbles: true, data: newTitle }));
                  visTb.dispatchEvent(new Event('change', { bubbles: true }));
                  visTb.blur();
                }
                return (visTb.textContent || '').trim() === newTitle;
              }, title)
              .catch(() => false);

            if (titleVerified) break;
            await uploadPage.waitForTimeout(700);
          }

          // Wait 2 seconds after setting title
          await uploadPage.waitForTimeout(2000);

          // Step 3: Select "No, it's not made for kids" on the VISIBLE radio button and verify aria-checked="true"
          const ensureNotMadeForKidsChecked = async (): Promise<boolean> => {
            for (let mfkTry = 1; mfkTry <= 3; mfkTry++) {
              const mfkInfo = await uploadPage
                .evaluate(() => {
                  const isVis = (el: Element | null): el is HTMLElement => {
                    if (!el || !(el instanceof HTMLElement)) return false;
                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);
                    return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
                  };
                  const radios = Array.from(
                    document.querySelectorAll(
                      'ytcp-uploads-dialog tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], #audience tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'
                    )
                  );
                  const target = (radios.find((el) => isVis(el)) || radios[0]) as HTMLElement | undefined;
                  if (!target) return null;
                  target.scrollIntoView({ block: 'center' });
                  target.click();
                  const inner = target.querySelector('#radioContainer, #offRadio') as HTMLElement | null;
                  if (inner) inner.click();
                  const r = target.getBoundingClientRect();
                  return {
                    checked: target.getAttribute('aria-checked') === 'true',
                    x: Math.round(r.left + Math.min(24, r.width / 2)),
                    y: Math.round(r.top + r.height / 2),
                    w: r.width,
                    h: r.height,
                  };
                })
                .catch(() => null);

              if (mfkInfo?.checked) return true;
              if (mfkInfo && mfkInfo.w > 4 && mfkInfo.h > 4) {
                await uploadPage.mouse.click(mfkInfo.x, mfkInfo.y).catch(() => {});
                await uploadPage.waitForTimeout(400);
              }
              const nowChecked = await uploadPage
                .evaluate(() => {
                  const radios = Array.from(
                    document.querySelectorAll(
                      'ytcp-uploads-dialog tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'
                    )
                  );
                  return radios.some((r) => r.getAttribute('aria-checked') === 'true');
                })
                .catch(() => false);
              if (nowChecked) return true;
            }
            return false;
          };

          await ensureNotMadeForKidsChecked();
          // Wait 2 seconds after clicking "Not made for kids"
          await uploadPage.waitForTimeout(2000);

          let shareUrl = await this.extractShareUrlFromUploadModal(uploadPage, ignoreVideoIds);

          // Step 4: Advance to Visibility step (check if VISIBLE Unlisted/Private radio is on screen; if not, click Next or #step-badge-3)
          const targetRadioName = visibility === 'private' ? 'PRIVATE' : 'UNLISTED';
          const isVisibilityRadioVisibleOnScreen = async (): Promise<boolean> => {
            return uploadPage
              .evaluate((rName: string) => {
                const isVis = (el: Element | null): boolean => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                const radios = Array.from(
                  document.querySelectorAll(
                    `ytcp-uploads-dialog tp-yt-paper-radio-button[name="${rName}"], #privacy-radios tp-yt-paper-radio-button[name="${rName}"], tp-yt-paper-radio-button[name="${rName}"]`
                  )
                );
                return radios.some((el) => isVis(el));
              }, targetRadioName)
              .catch(() => false);
          };

          for (let stepIdx = 0; stepIdx < 6; stepIdx++) {
            if (!shareUrl) {
              shareUrl = await this.extractShareUrlFromUploadModal(uploadPage, ignoreVideoIds);
            }
            if (await isVisibilityRadioVisibleOnScreen()) {
              break;
            }
            // Re-ensure "Not made for kids" is checked in case Details validation blocked Next
            if (stepIdx > 0) {
              await ensureNotMadeForKidsChecked();
            }

            // Click the visible Next button (or Visibility stepper badge #step-badge-3 on later tries)
            const nextClickCoords = await uploadPage
              .evaluate((tryStepperDirect: boolean) => {
                const isVis = (el: Element | null): el is HTMLElement => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                if (tryStepperDirect) {
                  const stepBadges = Array.from(
                    document.querySelectorAll(
                      'ytcp-uploads-dialog #step-badge-3, ytcp-uploads-dialog [test-id="REVIEW"], #step-badge-3'
                    )
                  );
                  const visBadge = stepBadges.find((el) => isVis(el));
                  if (visBadge) {
                    visBadge.click();
                    const r = visBadge.getBoundingClientRect();
                    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                  }
                }
                const nextBtns = Array.from(
                  document.querySelectorAll(
                    'ytcp-uploads-dialog #next-button button, ytcp-uploads-dialog #next-button, #next-button button, ytcp-button#next-button'
                  )
                );
                const visNext = nextBtns.find((el) => isVis(el));
                if (visNext) {
                  visNext.click();
                  const r = visNext.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                }
                return null;
              }, stepIdx >= 3)
              .catch(() => null);

            if (nextClickCoords) {
              await uploadPage.mouse.click(nextClickCoords.x, nextClickCoords.y).catch(() => {});
            }
            // Wait 2 seconds after each Next click so the next tab step loads completely
            await uploadPage.waitForTimeout(2000);
          }

          // Step 5: Select Unlisted (or Private) radio button on the VISIBLE Visibility step and verify aria-checked="true"
          for (let visTry = 1; visTry <= 4; visTry++) {
            const visCoords = await uploadPage
              .evaluate((rName: string) => {
                const isVis = (el: Element | null): el is HTMLElement => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                const radios = Array.from(
                  document.querySelectorAll(
                    `ytcp-uploads-dialog tp-yt-paper-radio-button[name="${rName}"], #privacy-radios tp-yt-paper-radio-button[name="${rName}"], tp-yt-paper-radio-button[name="${rName}"]`
                  )
                );
                const target = radios.find((el) => isVis(el)) as HTMLElement | undefined;
                if (!target) return null;
                target.scrollIntoView({ block: 'center' });
                target.click();
                const inner = target.querySelector('#radioContainer, #offRadio') as HTMLElement | null;
                if (inner) inner.click();
                const r = target.getBoundingClientRect();
                return {
                  checked: target.getAttribute('aria-checked') === 'true',
                  x: Math.round(r.left + Math.min(24, r.width / 2)),
                  y: Math.round(r.top + r.height / 2),
                  w: r.width,
                  h: r.height,
                };
              }, targetRadioName)
              .catch(() => null);

            if (visCoords?.checked) break;
            if (visCoords && visCoords.w > 4 && visCoords.h > 4) {
              await uploadPage.mouse.click(visCoords.x, visCoords.y).catch(() => {});
              await uploadPage.waitForTimeout(600);
              // Note: When a video is Blocked by copyright policy, YouTube Studio does NOT visually set aria-checked="true"
              // on the Unlisted radio button even though clicking it selects Unlisted! So break after clicking cleanly.
              break;
            }
          }

          // Wait 2 seconds after selecting Unlisted / Private
          await uploadPage.waitForTimeout(2000);

          // Step 6: Wait until file byte upload finishes (Uploading X% done & visible Save button enabled),
          // then click Save (#done-button) and VERIFY the Visibility step actually closes!
          const deadline = Date.now() + 150_000;
          while (Date.now() < deadline) {
            if (!shareUrl) {
              shareUrl = await this.extractShareUrlFromUploadModal(uploadPage, ignoreVideoIds);
            }
            const readyToSave = await uploadPage
              .evaluate(() => {
                const isVis = (el: Element | null): el is HTMLElement => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                const hosts = Array.from(
                  document.querySelectorAll('ytcp-uploads-dialog #done-button, ytcp-button#done-button, #done-button')
                );
                const host = hosts.find((el) => isVis(el)) as HTMLElement | undefined;
                const innerBtn = host?.querySelector('button') as HTMLButtonElement | null;
                const progEl = document.querySelector(
                  'ytcp-uploads-dialog ytcp-video-upload-progress, ytcp-video-upload-progress, .progress-label'
                ) as HTMLElement | null;
                const progTxt = (progEl?.innerText || progEl?.textContent || '').trim();
                const stillUploading = /uploading\s+\d*%/i.test(progTxt);
                const hostDisabled =
                  !host ||
                  host.hasAttribute('disabled') ||
                  host.getAttribute('aria-disabled') === 'true';
                const innerDisabled = Boolean(
                  innerBtn &&
                    (innerBtn.disabled ||
                      innerBtn.hasAttribute('disabled') ||
                      innerBtn.getAttribute('aria-disabled') === 'true')
                );
                return !stillUploading && !hostDisabled && !innerDisabled;
              })
              .catch(() => false);

            if (readyToSave) {
              break;
            }
            await uploadPage.waitForTimeout(1000);
          }

          if (!shareUrl) {
            shareUrl = await this.extractShareUrlFromUploadModal(uploadPage, ignoreVideoIds);
          }

          // Click the VISIBLE Save / Done button and verify the Visibility dialog closes (retry up to 6 times)
          for (let saveTry = 1; saveTry <= 6; saveTry++) {
            const doneCoords = await uploadPage
              .evaluate((rName: string) => {
                const isVis = (el: Element | null): el is HTMLElement => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                // If still on Details / Video elements / Checks tab (#next-button visible), click #step-badge-3 or #next-button first
                const nextBtns = Array.from(
                  document.querySelectorAll(
                    'ytcp-uploads-dialog #next-button button, ytcp-uploads-dialog #next-button'
                  )
                );
                const visNext = nextBtns.find((el) => isVis(el));
                if (visNext) {
                  const stepBadges = Array.from(
                    document.querySelectorAll('ytcp-uploads-dialog #step-badge-3, #step-badge-3')
                  );
                  const visBadge = stepBadges.find((el) => isVis(el));
                  if (visBadge) visBadge.click();
                  else visNext.click();
                }

                // Ensure Unlisted/Private radio is selected if visible
                const radios = Array.from(
                  document.querySelectorAll(
                    `ytcp-uploads-dialog tp-yt-paper-radio-button[name="${rName}"], #privacy-radios tp-yt-paper-radio-button[name="${rName}"], tp-yt-paper-radio-button[name="${rName}"]`
                  )
                );
                const visRadio = radios.find((el) => isVis(el));
                if (visRadio && visRadio.getAttribute('aria-checked') !== 'true') {
                  visRadio.click();
                }

                const candidates = Array.from(
                  document.querySelectorAll(
                    'ytcp-uploads-dialog #done-button button, ytcp-uploads-dialog #done-button, #done-button button, ytcp-button#done-button'
                  )
                );
                const visDone = candidates.find((el) => isVis(el));
                if (!visDone) return null;
                visDone.scrollIntoView({ block: 'center' });
                visDone.click();
                const inner = visDone.querySelector('button') as HTMLElement | null;
                if (inner) inner.click();
                const r = visDone.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }, targetRadioName)
              .catch(() => null);

            if (doneCoords) {
              await uploadPage.mouse.click(doneCoords.x, doneCoords.y).catch(() => {});
            }

            // Wait 1.5s then check if "We're still checking your content" popup appeared (Screenshot 2)
            await uploadPage.waitForTimeout(1500);
            const handledStillChecking = await this.handleStillCheckingContentPopup(
              uploadPage,
              targetRadioName
            );
            if (!handledStillChecking) {
              await uploadPage.waitForTimeout(1000);
            }

            if (!shareUrl) {
              shareUrl = await this.extractShareUrlFromUploadModal(uploadPage, ignoreVideoIds);
            }

            // Check if ANY visible #done-button, #next-button, or visibility radio inside ytcp-uploads-dialog is still on screen
            const modalStillOnEditOrVisibility = await uploadPage
              .evaluate((rName: string) => {
                const isVis = (el: Element | null): boolean => {
                  if (!el || !(el instanceof HTMLElement)) return false;
                  const r = el.getBoundingClientRect();
                  const s = window.getComputedStyle(el);
                  return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
                };
                const postSaveOpen = Array.from(
                  document.querySelectorAll('ytcp-uploads-still-processing-dialog, ytcp-video-share-dialog')
                ).some((el) => isVis(el));
                if (postSaveOpen) return false;

                const editOrVisOpen = Array.from(
                  document.querySelectorAll(
                    `ytcp-uploads-dialog #done-button, ytcp-uploads-dialog #next-button, ytcp-uploads-dialog tp-yt-paper-radio-button[name="${rName}"], ytcp-uploads-dialog #title-textarea`
                  )
                ).some((el) => isVis(el));
                return editOrVisOpen;
              }, targetRadioName)
              .catch(() => false);

            if (!modalStillOnEditOrVisibility) {
              break;
            }
          }

          if (!shareUrl) {
            shareUrl = await this.extractShareUrlFromUploadModal(uploadPage, ignoreVideoIds);
          }

          // IMMEDIATELY close the "Video processing" / "Checks complete. Claimed content found." popup and wait 2s!
          await this.dismissAllUploadDialogs(uploadPage);
          await uploadPage.waitForTimeout(2000);

          // Check on the Channel Content page if this newly uploaded video accidentally ended up as "Draft" or "Private"
          // ("notic kro draft to nhi bna agr draft bna to unlisted kr do")
          if (visibility === 'unlisted') {
            const extractedVidId =
              shareUrl?.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)?.[1] ||
              shareUrl?.match(/\/video\/([a-zA-Z0-9_-]{11})/)?.[1] ||
              undefined;
            await this.convertVideoRowToUnlistedOnContentPage(uploadPage, {
              videoId: extractedVidId,
              title,
              windowNumber,
              scanPrefix,
            }).catch(() => {});
          }

          // If shareUrl was not captured inside the dialog, read it from the Content table row by exact title or windowNumber
          if (!shareUrl) {
            const contentSummary = await this.checkAndVerifyContentPage({
              scanId,
              expectedWindows: [{ windowNumber, clipPath, title }],
              waitForSdReady: false,
              username,
            });
            const matched = contentSummary.items.find(
              (it) =>
                (it.title === title || it.windowNumber === windowNumber) &&
                !ignoreVideoIds.has(it.videoId)
            );
            if (matched?.ytUrl) {
              shareUrl = matched.ytUrl;
            }
          }

          if (!shareUrl) {
            throw new Error('Upload saved, but could not extract https://youtu.be/<id> share URL from dialog or Content page.');
          }

          const idMatch =
            shareUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
            shareUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
            shareUrl.match(/shorts\/([a-zA-Z0-9_-]{11})/) ||
            shareUrl.match(/\/video\/([a-zA-Z0-9_-]{11})/);
          const ytVideoId = idMatch ? idMatch[1] : shareUrl;
          const normalizedUrl = idMatch ? `https://youtu.be/${idMatch[1]}` : shareUrl;

          this.uploadedVideoIdsInSession.add(ytVideoId);

          saveClipYtSidecar(clipPath, {
            scanId,
            windowNumber,
            ytUrl: normalizedUrl,
            ytVideoId,
            ytUploadedAt: Date.now(),
            ytDeleted: false,
          });

          onProgress?.('link ready');
          this.log(
            'upload complete',
            `[W${String(windowNumber).padStart(2, '0')}] Uploaded -> ${normalizedUrl} (popup closed, ready for next)`,
            'ok'
          );

          return {
            ytUrl: normalizedUrl,
            ytVideoId,
            reused: false,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          lastErr = err instanceof Error ? err : new Error(msg);

          this.log(
            'upload error',
            `[W${String(windowNumber).padStart(2, '0')}] Attempt ${attempt}/2 failed: ${msg}`,
            'error'
          );
          await this.dumpFailureScreenshot(uploadPage, `upload-w${windowNumber}-a${attempt}`);
          await this.dismissAllUploadDialogs(uploadPage).catch(() => {});
          await uploadPage.waitForTimeout(2000).catch(() => {});
        } finally {
          await this.releaseUploadPage(uploadPage);
          if (this.busyUploadPages.size === 0) {
            this.status = this.assistMode ? 'assist' : 'ready';
          }
        }
      }

      this.status = 'error';
      throw lastErr || new Error(`Failed to upload window ${windowNumber} to YouTube Studio`);
    });

    this.inFlightClipUploads.set(clipPath, runUploadPromise);
    try {
      return await runUploadPromise;
    } finally {
      this.inFlightClipUploads.delete(clipPath);
    }
  }

  /**
   * Handles the "We're still checking your content" popup in YouTube Studio (Screenshot 2):
   * 1. When this popup appears on Save, it otherwise leaves the video in Draft ("Saved as private").
   * 2. First clicks the top-right × (cross) button on the popup, re-selects Unlisted, and clicks Save (#done-button).
   * 3. If the popup re-appears on Save, clicks "Publish anyway" so YouTube Studio immediately commits
   *    the video as Unlisted instead of Draft.
   */
  private async handleStillCheckingContentPopup(
    page: Page,
    targetRadioName: string = 'UNLISTED'
  ): Promise<boolean> {
    try {
      const detectCheckingDialog = async (): Promise<boolean> => {
        return await page
          .evaluate(() => {
            const dialogs = Array.from(
              document.querySelectorAll(
                'tp-yt-paper-dialog, ytcp-confirmation-dialog, ytcp-dialog, [role="dialog"]'
              )
            ) as HTMLElement[];
            for (const d of dialogs) {
              if (d.offsetWidth === 0 && d.offsetHeight === 0) continue;
              const txt = (d.innerText || d.textContent || '').toLowerCase();
              if (
                txt.includes('still checking your content') ||
                txt.includes('keeping your content private until checks complete') ||
                txt.includes('publish anyway')
              ) {
                return true;
              }
            }
            return false;
          })
          .catch(() => false);
      };

      if (!(await detectCheckingDialog())) {
        return false;
      }

      this.log(
        'checking popup',
        'Detected "We\'re still checking your content" popup -> clicking top-right × (cross) button, re-selecting Unlisted, and saving...',
        'info'
      );

      // Step 1: Click the top-right × (cross) button on the "We're still checking your content" popup
      const clickedCross = await page
        .evaluate(() => {
          const dialogs = Array.from(
            document.querySelectorAll(
              'tp-yt-paper-dialog, ytcp-confirmation-dialog, ytcp-dialog, [role="dialog"]'
            )
          ) as HTMLElement[];
          for (const d of dialogs) {
            if (d.offsetWidth === 0 && d.offsetHeight === 0) continue;
            const txt = (d.innerText || d.textContent || '').toLowerCase();
            if (
              !txt.includes('still checking your content') &&
              !txt.includes('keeping your content private until checks complete') &&
              !txt.includes('publish anyway')
            ) {
              continue;
            }
            // Don't accidentally click the outer upload dialog's close button
            if (d.tagName.toLowerCase() === 'ytcp-uploads-dialog') continue;

            const closeSelectors = [
              '#close-button',
              '#close-icon-button',
              'ytcp-icon-button[aria-label*="Close" i]',
              'button[aria-label*="Close" i]',
              '[aria-label="Close"]',
              'tp-yt-iron-icon[icon*="close"]',
            ];
            for (const sel of closeSelectors) {
              const btn = d.querySelector(sel) as HTMLElement | null;
              if (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0)) {
                btn.click();
                return true;
              }
            }
          }
          return false;
        })
        .catch(() => false);

      if (clickedCross) {
        await page.waitForTimeout(700).catch(() => {});
        // Re-select Unlisted radio button inside the Visibility step
        await page
          .evaluate((radioName: string) => {
            const radio = document.querySelector(
              `tp-yt-paper-radio-button[name="${radioName}"], #privacy-radios tp-yt-paper-radio-button[name="${radioName}"]`
            ) as HTMLElement | null;
            if (radio) {
              radio.scrollIntoView({ block: 'center' });
              radio.click();
            }
          }, targetRadioName)
          .catch(() => {});
        await page.waitForTimeout(450).catch(() => {});

        // Click Save (#done-button) again
        const doneBtn = page.locator('#done-button').first();
        if (await doneBtn.isVisible().catch(() => false)) {
          await doneBtn.click({ force: true, timeout: 4000 }).catch(() => {});
        } else {
          await page
            .evaluate(() => {
              const b = document.querySelector('#done-button') as HTMLElement | null;
              if (b) b.click();
            })
            .catch(() => {});
        }
        await page.waitForTimeout(1500).catch(() => {});
      }

      // Step 2: If "We're still checking your content" is still visible (or popped up again on Save),
      // click "Publish anyway" (or confirm button) so YouTube commits Unlisted instead of Draft.
      if (await detectCheckingDialog()) {
        this.log(
          'checking popup',
          '"We\'re still checking your content" popup re-appeared on Save -> clicking "Publish anyway" to force Unlisted',
          'info'
        );
        const publishAnywayClicked = await page
          .evaluate(() => {
            const dialogs = Array.from(
              document.querySelectorAll(
                'tp-yt-paper-dialog, ytcp-confirmation-dialog, ytcp-dialog, [role="dialog"]'
              )
            ) as HTMLElement[];
            for (const d of dialogs) {
              if (d.offsetWidth === 0 && d.offsetHeight === 0) continue;
              const txt = (d.innerText || d.textContent || '').toLowerCase();
              if (
                !txt.includes('still checking your content') &&
                !txt.includes('publish anyway')
              ) {
                continue;
              }
              const buttons = Array.from(
                d.querySelectorAll('ytcp-button, button, [role="button"], #confirm-button')
              ) as HTMLElement[];
              for (const b of buttons) {
                const bTxt = (b.innerText || b.textContent || '').trim().toLowerCase();
                if (
                  bTxt.includes('publish anyway') ||
                  bTxt.includes('change visibility') ||
                  b.id === 'confirm-button'
                ) {
                  b.click();
                  return true;
                }
              }
            }
            return false;
          })
          .catch(() => false);

        if (publishAnywayClicked) {
          await page.waitForTimeout(1800).catch(() => {});
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Finds a video row (`ytcp-video-row`) on the YouTube Studio Content page by `videoId`, `title`, or `windowNumber`,
   * and if its visibility is `Draft` (`Edit draft`, `Draft (Blocked)`, `Draft (Checking)`) or `Private` (`Private`, `Private (Blocked)`),
   * converts it to `Unlisted` using the exact user-specified flow:
   *   1. Find the row where `Draft` (or `Private`) is shown.
   *   2. Click on `Draft` -> then click the Pencil icon (`Details` / `Edit draft`) to open the upload/visibility dialog.
   *   3. Go to the `Visibility` tab (same as at upload time).
   *   4. Click `Unlisted` (even on Blocked videos where the radio button does not visually show enabled, the click still selects Unlisted!).
   *   5. Click `Save` (`#done-button`).
   *   6. Click `Done` / `Publish anyway` / `Close` on the secondary popup (`"Video published"` or confirmation dialog).
   *   7. Confirm on the Channel Content row that `Draft` has changed to `Unlisted`; if not, retry (up to 3 attempts).
   */
  public async convertVideoRowToUnlistedOnContentPage(
    page: Page,
    target: {
      videoId?: string;
      title?: string;
      windowNumber?: number;
      scanPrefix?: string;
    }
  ): Promise<boolean> {
    try {
      const targetLabel =
        target.title ||
        (target.windowNumber ? `W${String(target.windowNumber).padStart(2, '0')}` : '') ||
        target.videoId ||
        'video';

      // Make sure we are on the Channel Content page and rows are visible
      const currentUrl = page.url();
      if (!currentUrl.includes('studio.youtube.com') || !currentUrl.includes('/videos')) {
        const chId = this.channelId;
        const targetContentUrl = chId
          ? `https://studio.youtube.com/channel/${chId}/videos/upload?filter=%5B%5D`
          : 'https://studio.youtube.com/channel/mine/videos/upload';
        this.log(
          'draft->unlisted',
          `[${targetLabel}] Navigating to YouTube Studio Content page (${targetContentUrl})...`,
          'info'
        );
        await page
          .goto(targetContentUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 35000,
          })
          .catch(() => {});
        await page.waitForTimeout(2500).catch(() => {});
      }

      await this.dismissAllUploadDialogs(page).catch(() => {});
      await page.waitForSelector('ytcp-video-row', { timeout: 12000 }).catch(() => {});

      const inspectTargetRowOnTable = async () => {
        return await page
          .evaluate(
            (t: { videoId?: string; title?: string; windowNumber?: number; scanPrefix?: string }) => {
              const isVis = (el: Element | null): el is HTMLElement => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
              };

              const rows = Array.from(document.querySelectorAll('ytcp-video-row')) as HTMLElement[];
              for (let idx = 0; idx < rows.length; idx++) {
                const row = rows[idx];
                const rowText = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
                const rowLower = rowText.toLowerCase();

                const titleEl = row.querySelector(
                  '#video-title, a#video-title, .video-title-wrapper'
                ) as HTMLElement | null;
                const rawTitle = (titleEl?.innerText || titleEl?.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim();

                let vid = '';
                const anchors = Array.from(row.querySelectorAll('a[href]')) as HTMLAnchorElement[];
                for (const a of anchors) {
                  const href = a.getAttribute('href') || a.href || '';
                  const mEdit = href.match(/\/video\/([a-zA-Z0-9_-]{11})/);
                  if (mEdit) {
                    vid = mEdit[1];
                    break;
                  }
                  const mShort =
                    href.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
                    href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
                  if (mShort) {
                    vid = mShort[1];
                    break;
                  }
                }
                if (!vid) {
                  const imgs = Array.from(row.querySelectorAll('img[src]')) as HTMLImageElement[];
                  for (const img of imgs) {
                    const src = img.getAttribute('src') || img.src || '';
                    const mThumb = src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
                    if (mThumb) {
                      vid = mThumb[1];
                      break;
                    }
                  }
                }
                if (!vid) {
                  const html = row.outerHTML || '';
                  const mHtml =
                    html.match(/\/video\/([a-zA-Z0-9_-]{11})/) ||
                    html.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
                  if (mHtml) vid = mHtml[1];
                }

                let matches = false;
                if (t.videoId && vid && vid === t.videoId) {
                  matches = true;
                } else if (t.title && rawTitle.toLowerCase() === t.title.toLowerCase()) {
                  matches = true;
                } else if (
                  t.windowNumber !== undefined &&
                  t.scanPrefix &&
                  rawTitle.toLowerCase() === `${t.scanPrefix.toLowerCase()}-w${t.windowNumber}`
                ) {
                  matches = true;
                } else if (
                  t.windowNumber !== undefined &&
                  new RegExp(`^cmt-[a-z0-9_-]+-w${t.windowNumber}\\b`, 'i').test(rawTitle) &&
                  (!t.scanPrefix || rawTitle.toLowerCase().startsWith(`cmt-${t.scanPrefix.toLowerCase()}-`))
                ) {
                  matches = true;
                } else if (
                  t.windowNumber !== undefined &&
                  !t.scanPrefix &&
                  new RegExp(`-w${t.windowNumber}\\b`, 'i').test(rawTitle)
                ) {
                  matches = true;
                }

                if (!matches) continue;

                const visCell = row.querySelector(
                  'ytcp-video-list-cell-visibility, .cell-body.tablecell-visibility, .tablecell-visibility, #visibility-label'
                ) as HTMLElement | null;
                const visLabelEl = row.querySelector(
                  '#visibility-label, ytcp-video-list-cell-visibility #visibility-label'
                ) as HTMLElement | null;
                const rawVisText = (
                  visLabelEl?.innerText ||
                  visCell?.innerText ||
                  visLabelEl?.textContent ||
                  visCell?.textContent ||
                  ''
                )
                  .replace(/\s+/g, ' ')
                  .trim();
                const visLower = rawVisText.toLowerCase();

                const hasEditDraftBtn = Array.from(
                  row.querySelectorAll('ytcp-button, button, a, [role="button"]')
                ).some((el) =>
                  ((el as HTMLElement).innerText || el.textContent || '')
                    .trim()
                    .toLowerCase()
                    .includes('edit draft')
                );

                const isDraft =
                  hasEditDraftBtn || /\bdraft\b/i.test(visLower) || /\bedit\s+draft\b/i.test(rowLower);
                const isPrivate = !isDraft && /\bprivate\b/i.test(visLower);
                const isUnlisted = /\bunlisted\b/i.test(visLower) && !isDraft && !isPrivate;

                rows.forEach((r) => r.removeAttribute('data-cmt-target-unlisted-row'));
                row.setAttribute('data-cmt-target-unlisted-row', 'true');
                row.scrollIntoView({ block: 'center' });

                const rowRect = row.getBoundingClientRect();
                const draftTarget = (visLabelEl && isVis(visLabelEl) ? visLabelEl : visCell) || row;
                const draftRect = draftTarget.getBoundingClientRect();

                return {
                  found: true,
                  videoId: vid,
                  title: rawTitle || t.title || '',
                  rawVisText: rawVisText || (isDraft ? 'Draft' : isPrivate ? 'Private' : 'Unlisted'),
                  isDraft,
                  isPrivate,
                  isUnlisted,
                  hasEditDraftBtn,
                  rowCenterX: Math.round(rowRect.left + Math.min(220, rowRect.width / 3)),
                  rowCenterY: Math.round(rowRect.top + rowRect.height / 2),
                  draftClickX: Math.round(draftRect.left + draftRect.width / 2),
                  draftClickY: Math.round(draftRect.top + draftRect.height / 2),
                };
              }
              return {
                found: false,
                videoId: '',
                title: '',
                rawVisText: '',
                isDraft: false,
                isPrivate: false,
                isUnlisted: false,
                hasEditDraftBtn: false,
                rowCenterX: 0,
                rowCenterY: 0,
                draftClickX: 0,
                draftClickY: 0,
              };
            },
            target
          )
          .catch(() => ({
            found: false,
            videoId: '',
            title: '',
            rawVisText: '',
            isDraft: false,
            isPrivate: false,
            isUnlisted: false,
            hasEditDraftBtn: false,
            rowCenterX: 0,
            rowCenterY: 0,
            draftClickX: 0,
            draftClickY: 0,
          }));
      };

      const initialCheck = await inspectTargetRowOnTable();
      if (!initialCheck.found) {
        this.log(
          'draft->unlisted',
          `[${targetLabel}] Row not found on current Channel Content view (videoId=${target.videoId || 'none'}, title=${target.title || 'none'})`,
          'warn'
        );
        return false;
      }

      if (initialCheck.isUnlisted) {
        this.log(
          'draft->unlisted',
          `[${targetLabel}] Confirmed: "${initialCheck.title}" (${initialCheck.videoId || 'video'}) is already Unlisted`,
          'ok'
        );
        return true;
      }

      // Retry up to 3 times until "Draft" is confirmed changed to "Unlisted" on the Channel Content row
      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.dismissAllUploadDialogs(page).catch(() => {});
        const rowInfo = attempt === 1 ? initialCheck : await inspectTargetRowOnTable();
        if (!rowInfo.found) break;

        if (rowInfo.isUnlisted) {
          this.log(
            'draft->unlisted',
            `[${targetLabel}] CONFIRMED: "${rowInfo.title}" (${rowInfo.videoId || 'video'}) is now Unlisted!`,
            'ok'
          );
          return true;
        }

        this.log(
          'draft->unlisted',
          `[${targetLabel}] Attempt ${attempt}/3: Row "${rowInfo.title}" shows "${rowInfo.rawVisText}" -> Step 1: Clicking "Draft" on row to reveal Pencil / Edit draft icon...`,
          'info'
        );

        // Step 1: Click on "Draft" in the row's Visibility column and hover the row so the Pencil icon appears
        if (rowInfo.draftClickX > 0 && rowInfo.draftClickY > 0) {
          await page.mouse.move(rowInfo.draftClickX, rowInfo.draftClickY).catch(() => {});
          await page.mouse.click(rowInfo.draftClickX, rowInfo.draftClickY).catch(() => {});
        }
        if (rowInfo.rowCenterX > 0 && rowInfo.rowCenterY > 0) {
          await page.mouse.move(rowInfo.rowCenterX, rowInfo.rowCenterY).catch(() => {});
        }
        await page.waitForTimeout(550).catch(() => {});

        // Step 2: Click the Pencil icon (Details / Edit draft) or "Edit draft" button on the row
        const pencilOrDraftCoords = await page
          .evaluate(() => {
            const isVis = (el: Element | null): el is HTMLElement => {
              if (!el || !(el instanceof HTMLElement)) return false;
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden';
            };
            const row = document.querySelector(
              'ytcp-video-row[data-cmt-target-unlisted-row="true"]'
            ) as HTMLElement | null;
            if (!row) return null;

            // Priority 1: "Edit draft" button on the row (opens ytcp-uploads-dialog directly on Draft rows)
            const buttons = Array.from(
              row.querySelectorAll('ytcp-button, button, a, [role="button"]')
            ) as HTMLElement[];
            for (const el of buttons) {
              const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
              if (txt.includes('edit draft') && isVis(el)) {
                el.click();
                const inner = el.querySelector('button, a') as HTMLElement | null;
                if (inner) inner.click();
                const r = el.getBoundingClientRect();
                return {
                  label: 'Edit draft button',
                  x: Math.round(r.left + r.width / 2),
                  y: Math.round(r.top + r.height / 2),
                };
              }
            }

            // Priority 2: Pencil icon (Details button / create icon) on the hovered/clicked row
            const pencilSelectors = [
              'a#details-button',
              'ytcp-icon-button#details-button',
              '#details-button',
              'ytcp-icon-button[aria-label*="Details" i]',
              'a[aria-label*="Details" i]',
              'button[aria-label*="Details" i]',
              'tp-yt-iron-icon[icon*="create"]',
              '#video-title',
              'a#video-title',
            ];
            for (const sel of pencilSelectors) {
              const el = row.querySelector(sel) as HTMLElement | null;
              if (el && isVis(el)) {
                el.click();
                const r = el.getBoundingClientRect();
                return {
                  label: `Pencil icon (${sel})`,
                  x: Math.round(r.left + r.width / 2),
                  y: Math.round(r.top + r.height / 2),
                };
              }
            }
            return null;
          })
          .catch(() => null);

        if (pencilOrDraftCoords) {
          this.log(
            'draft->unlisted',
            `[${targetLabel}] Step 2: Clicking ${pencilOrDraftCoords.label} at (${pencilOrDraftCoords.x}, ${pencilOrDraftCoords.y})...`,
            'info'
          );
          await page.mouse.click(pencilOrDraftCoords.x, pencilOrDraftCoords.y).catch(() => {});
        }

        await page
          .waitForSelector('ytcp-uploads-dialog, ytcp-video-visibility-select, #step-badge-3', {
            timeout: 8000,
          })
          .catch(() => {});
        await page.waitForTimeout(1200).catch(() => {});

        // Step 3: Navigate to the Visibility tab inside ytcp-uploads-dialog (same as upload time)
        await page
          .evaluate(() => {
            const mfk = document.querySelector(
              'ytcp-uploads-dialog tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"], tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'
            ) as HTMLElement | null;
            if (mfk && mfk.getAttribute('aria-checked') !== 'true') {
              mfk.click();
            }
          })
          .catch(() => {});
        await page.waitForTimeout(350).catch(() => {});

        for (let stepTry = 0; stepTry < 4; stepTry++) {
          const onVisTab = await page
            .evaluate(() => {
              const isVis = (el: Element | null): boolean => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
              };
              const radios = Array.from(
                document.querySelectorAll(
                  'ytcp-uploads-dialog tp-yt-paper-radio-button[name="UNLISTED"], #privacy-radios tp-yt-paper-radio-button[name="UNLISTED"], tp-yt-paper-radio-button[name="UNLISTED"]'
                )
              );
              return radios.some((r) => isVis(r));
            })
            .catch(() => false);
          if (onVisTab) break;

          const navCoords = await page
            .evaluate((preferBadge: boolean) => {
              const isVis = (el: Element | null): el is HTMLElement => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
              };
              if (preferBadge) {
                const badges = Array.from(
                  document.querySelectorAll(
                    'ytcp-uploads-dialog #step-badge-3, ytcp-uploads-dialog [test-id="REVIEW"], #step-badge-3'
                  )
                );
                const b = badges.find((el) => isVis(el));
                if (b) {
                  b.click();
                  const r = b.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                }
              }
              const nexts = Array.from(
                document.querySelectorAll(
                  'ytcp-uploads-dialog #next-button button, ytcp-uploads-dialog #next-button, #next-button'
                )
              );
              const n = nexts.find((el) => isVis(el));
              if (n) {
                n.click();
                const r = n.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
              return null;
            }, stepTry === 0)
            .catch(() => null);

          if (navCoords) {
            await page.mouse.click(navCoords.x, navCoords.y).catch(() => {});
          }
          await page.waitForTimeout(900).catch(() => {});
        }

        // Step 4: Click "Unlisted" on the Visibility screen.
        // CRITICAL (from user): On Blocked videos, clicking "Unlisted" will NOT visually highlight/enable the radio button,
        // ("lekin es bar unlisted pr click krne pr bhi vo enable nhi dikhaega lekin vo ho gya he click jarur krna he")
        // so we MUST click it via both DOM and real mouse coordinates and proceed directly to Save!
        const unlistedClickCoords = await page
          .evaluate(() => {
            const isVis = (el: Element | null): el is HTMLElement => {
              if (!el || !(el instanceof HTMLElement)) return false;
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return r.width > 6 && r.height > 6 && s.display !== 'none' && s.visibility !== 'hidden';
            };
            const radios = Array.from(
              document.querySelectorAll(
                'ytcp-uploads-dialog tp-yt-paper-radio-button[name="UNLISTED"], #privacy-radios tp-yt-paper-radio-button[name="UNLISTED"], tp-yt-paper-radio-button[name="UNLISTED"]'
              )
            );
            const targetRadio = radios.find((el) => isVis(el)) as HTMLElement | undefined;
            if (!targetRadio) return null;

            targetRadio.removeAttribute('disabled');
            targetRadio.removeAttribute('aria-disabled');
            targetRadio.style.removeProperty('pointer-events');
            targetRadio.scrollIntoView({ block: 'center' });
            targetRadio.click();

            const radioCircle = targetRadio.querySelector(
              '#radioContainer, #offRadio, #onRadio'
            ) as HTMLElement | null;
            if (radioCircle) radioCircle.click();
            const radioLabel = targetRadio.querySelector('#radioLabel') as HTMLElement | null;
            if (radioLabel) radioLabel.click();

            const rect = (radioCircle || targetRadio).getBoundingClientRect();
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            };
          })
          .catch(() => null);

        if (unlistedClickCoords) {
          await page.mouse.click(unlistedClickCoords.x, unlistedClickCoords.y).catch(() => {});
          this.log(
            'draft->unlisted',
            `[${targetLabel}] Step 3 & 4: Reached Visibility & clicked "Unlisted" at (${unlistedClickCoords.x}, ${unlistedClickCoords.y}) (note: radio may stay visually unhighlighted on Blocked video, but click is active)`,
            'info'
          );
        } else {
          this.log(
            'draft->unlisted',
            `[${targetLabel}] Step 4 warn: Could not find visible Unlisted radio on attempt ${attempt}/3`,
            'warn'
          );
        }

        await page.waitForTimeout(1000).catch(() => {});

        // Step 5: Click Save (#done-button)
        const saveCoords = await page
          .evaluate(() => {
            const isVis = (el: Element | null): el is HTMLElement => {
              if (!el || !(el instanceof HTMLElement)) return false;
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden';
            };
            const candidates = Array.from(
              document.querySelectorAll(
                'ytcp-uploads-dialog #done-button button, ytcp-uploads-dialog #done-button, #done-button button, ytcp-button#done-button, #save-button'
              )
            );
            const btn = candidates.find((el) => isVis(el));
            if (!btn) return null;
            btn.removeAttribute('disabled');
            btn.removeAttribute('aria-disabled');
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            const inner = btn.querySelector('button') as HTMLElement | null;
            if (inner) {
              inner.removeAttribute('disabled');
              inner.click();
            }
            const r = btn.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })
          .catch(() => null);

        if (saveCoords) {
          await page.mouse.click(saveCoords.x, saveCoords.y).catch(() => {});
          this.log(
            'draft->unlisted',
            `[${targetLabel}] Step 5: Clicked "Save" (#done-button) at (${saveCoords.x}, ${saveCoords.y})`,
            'info'
          );
        }

        await page.waitForTimeout(1600).catch(() => {});

        // Step 6: Handle the secondary popup ("fir ek or pop up ayega done dbao" / "Publish anyway" / "Video published" Close)
        await this.handleStillCheckingContentPopup(page, 'UNLISTED');

        for (let popPoll = 0; popPoll < 4; popPoll++) {
          const popupBtnClicked = await page
            .evaluate(() => {
              const isVis = (el: Element | null): el is HTMLElement => {
                if (!el || !(el instanceof HTMLElement)) return false;
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 6 && r.height > 6 && s.display !== 'none' && s.visibility !== 'hidden';
              };
              const dialogs = Array.from(
                document.querySelectorAll(
                  'ytcp-video-share-dialog, ytcp-uploads-still-processing-dialog, ytcp-confirmation-dialog, tp-yt-paper-dialog[aria-modal="true"], tp-yt-paper-dialog, ytcp-dialog, [role="dialog"]'
                )
              ) as HTMLElement[];

              for (const dlg of dialogs) {
                if (!isVis(dlg)) continue;
                if (dlg.tagName.toLowerCase() === 'ytcp-uploads-dialog') continue;

                const buttons = Array.from(
                  dlg.querySelectorAll(
                    'ytcp-button, button, [role="button"], #confirm-button, #done-button, #close-button, #close-icon-button'
                  )
                ) as HTMLElement[];

                // First check for "Done", "Publish anyway", "Confirm", "Save", or "Close"
                for (const b of buttons) {
                  if (!isVis(b)) continue;
                  const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                  const id = (b.getAttribute('id') || '').toLowerCase();
                  const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                  if (
                    txt === 'done' ||
                    txt === 'publish anyway' ||
                    txt === 'close' ||
                    txt === 'got it' ||
                    id === 'confirm-button' ||
                    id === 'close-button' ||
                    aria === 'close'
                  ) {
                    b.click();
                    const inner = b.querySelector('button, tp-yt-iron-icon') as HTMLElement | null;
                    if (inner) inner.click();
                    const r = b.getBoundingClientRect();
                    return {
                      label: txt || id || aria || 'popup-button',
                      x: Math.round(r.left + r.width / 2),
                      y: Math.round(r.top + r.height / 2),
                    };
                  }
                }
              }
              return null;
            })
            .catch(() => null);

          if (popupBtnClicked) {
            await page.mouse.click(popupBtnClicked.x, popupBtnClicked.y).catch(() => {});
            this.log(
              'draft->unlisted',
              `[${targetLabel}] Step 6: Clicked "${popupBtnClicked.label}" on post-Save popup`,
              'info'
            );
            await page.waitForTimeout(900).catch(() => {});
          } else {
            break;
          }
        }

        await this.dismissAllUploadDialogs(page).catch(() => {});
        await page.waitForTimeout(1800).catch(() => {});

        // Step 7: Confirm on the Channel Content table that "Draft" has changed to "Unlisted"!
        // ("or fir draft confirm kro draft ki jagah unlisted aya he ya nhi nhi to fir se kro")
        let verifyRow = await inspectTargetRowOnTable();
        if (verifyRow.found && !verifyRow.isUnlisted && attempt >= 2) {
          // Reload Content table once to be 100% sure DOM isn't showing stale Draft badge
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForSelector('ytcp-video-row', { timeout: 12000 }).catch(() => {});
          await page.waitForTimeout(1500).catch(() => {});
          verifyRow = await inspectTargetRowOnTable();
        }

        if (verifyRow.found && verifyRow.isUnlisted) {
          this.log(
            'draft->unlisted',
            `[${targetLabel}] Step 7 CONFIRMED: "${verifyRow.title}" (${verifyRow.videoId || 'video'}) changed from Draft -> Unlisted (attempt ${attempt}/3)!`,
            'ok'
          );
          return true;
        }

        this.log(
          'draft->unlisted',
          `[${targetLabel}] Step 7 check: "${verifyRow.title || targetLabel}" still shows "${
            verifyRow.rawVisText || 'Draft'
          }" after attempt ${attempt}/3${attempt < 3 ? ' -> retrying...' : ''}`,
          'warn'
        );
      }

      return false;
    } catch (err: unknown) {
      this.log(
        'draft->unlisted error',
        `Could not convert row to Unlisted: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      return false;
    }
  }

  /**
   * Sequential 1-by-1 FIFO queue for AI Studio worker windows that encounter "This video is private"
   * mid-script (Screenshot 1). Multiple worker windows queue up in order (1st -> 2nd -> 3rd) without
   * interrupting other parallel workers, wait until their video is converted to Unlisted in YouTube Studio,
   * and then resume on their fresh AI Studio page.
   */
  public async enqueueMakeVideoUnlisted(params: {
    scanId?: string;
    windowNumber?: number;
    videoId?: string;
    youtubeUrl?: string;
    username?: string;
    workerLabel?: string;
    onLog?: (msg: string) => void;
  }): Promise<boolean> {
    this.ensureInternalCollections();
    const {
      scanId,
      windowNumber,
      videoId: rawVideoId,
      youtubeUrl,
      username = 'admin',
      workerLabel = 'W00',
      onLog,
    } = params;

    let videoId = rawVideoId || '';
    if (!videoId && youtubeUrl) {
      const m =
        youtubeUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
        youtubeUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
        youtubeUrl.match(/\/video\/([a-zA-Z0-9_-]{11})/);
      if (m) videoId = m[1];
    }

    const scanPrefix = scanId ? `cmt-${scanId.slice(0, 8)}` : undefined;
    const title =
      scanPrefix && windowNumber !== undefined ? `${scanPrefix}-w${windowNumber}` : undefined;
    const winTag =
      windowNumber !== undefined ? `W${String(windowNumber).padStart(2, '0')}` : videoId || 'video';

    this.unlistedFixQueuePending += 1;
    const queuePosition = this.unlistedFixQueuePending;

    const queueMsg = `[${workerLabel}] Queued Unlisted fix #${queuePosition} for ${winTag} (${
      videoId || title || youtubeUrl || 'video'
    }) — waiting in FIFO order`;
    this.log('private queue', queueMsg, 'info');
    onLog?.(queueMsg);

    let converted = false;
    const runTask = async () => {
      try {
        await this.withLock(async () => {
          const startMsg = `[${workerLabel}] Running queued Unlisted fix for ${winTag} (${
            videoId || title || 'video'
          }) in YouTube Studio...`;
          this.log('private fix start', startMsg, 'info');
          onLog?.(startMsg);

          const page = await this.ensurePage(username);
          converted = await this.convertVideoRowToUnlistedOnContentPage(page, {
            videoId: videoId || undefined,
            title,
            windowNumber,
            scanPrefix,
          });

          // Refresh Content table state after conversion so progress summary stays accurate
          await this.checkAndVerifyContentPage({
            scanId,
            expectedWindows:
              windowNumber !== undefined
                ? [{ windowNumber, title, videoId: videoId || undefined }]
                : [],
            waitForSdReady: false,
            username,
          }).catch(() => {});

          const doneMsg = converted
            ? `[${workerLabel}] ${winTag} (${videoId || title}) is now Unlisted — worker resuming on fresh page`
            : `[${workerLabel}] Finished Unlisted check for ${winTag} (${videoId || title}) — worker resuming`;
          this.log('private fix done', doneMsg, converted ? 'ok' : 'info');
          onLog?.(doneMsg);
        });
      } finally {
        this.unlistedFixQueuePending = Math.max(0, this.unlistedFixQueuePending - 1);
      }
    };

    const nextInQueue = this.unlistedFixQueue.then(runTask, runTask);
    this.unlistedFixQueue = nextInQueue.catch(() => {});
    await nextInQueue;
    return converted;
  }

  /**
   * Navigate to YouTube Studio -> Content (`Channel content`), dismiss any open "Video processing" popup,
   * inspect all uploaded video rows (`ytcp-video-row`), sync their `https://youtu.be/<id>` links to clip sidecars,
   * and optionally wait until SD processing finishes (`Unlisted`) while reporting live progress.
   */
  async checkAndVerifyContentPage(opts?: {
    scanId?: string;
    expectedWindows?: Array<{ windowNumber: number; clipPath?: string; title?: string; videoId?: string }>;
    waitForSdReady?: boolean;
    maxWaitMs?: number;
    username?: string;
    onProgress?: (summary: YtContentProgressSummary) => void;
  }): Promise<YtContentProgressSummary> {
    this.ensureInternalCollections();
    const {
      scanId,
      expectedWindows = [],
      waitForSdReady = false,
      maxWaitMs = 0,
      username = 'admin',
      onProgress,
    } = opts || {};

    const page = await this.ensurePage(username);

    // 1. First dismiss any open "Video processing" / "Checks complete. Claimed content found." popup on all open tabs
    if (this.context) {
      for (const p of this.context.pages().filter((pg) => !pg.isClosed())) {
        await this.dismissAllUploadDialogs(p).catch(() => {});
      }
    } else {
      await this.dismissAllUploadDialogs(page).catch(() => {});
    }

    // 2. Navigate to clean Channel Content page (`https://studio.youtube.com/channel/<id>/videos/upload?filter=%5B%5D`)
    // IMPORTANT: Never leave `?d=ud` in the URL, otherwise `page.reload()` re-opens the Upload Video modal!
    const ch = await this.verifyOrLockChannel(page, username).catch(() => ({
      channelId: this.channelId,
      channelHandle: this.channelHandle,
    }));
    let targetChannelId = ch.channelId || this.channelId;
    if (!targetChannelId) {
      const mUrl = page.url().match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
      if (mUrl) targetChannelId = mUrl[1];
    }
    let contentUrl = targetChannelId
      ? `https://studio.youtube.com/channel/${targetChannelId}/videos/upload?filter=%5B%5D`
      : 'https://studio.youtube.com';

    const curUrl = page.url();
    if (!curUrl.includes('/videos/upload') || curUrl.includes('d=ud')) {
      this.log('content check', `Opening YouTube Studio Content page (${contentUrl})...`, 'info');
      await page
        .goto(contentUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        })
        .catch(() => {});
      await page.waitForTimeout(2500);

      if (!targetChannelId) {
        const mUrlAfter = page.url().match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
        if (mUrlAfter) {
          targetChannelId = mUrlAfter[1];
          this.channelId = targetChannelId;
          contentUrl = `https://studio.youtube.com/channel/${targetChannelId}/videos/upload?filter=%5B%5D`;
        }
      }

      if (!page.url().includes('/videos') && targetChannelId) {
        await page
          .goto(contentUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 35000,
          })
          .catch(() => {});
      } else if (!page.url().includes('/videos')) {
        const contentNav = page
          .locator(
            'a#menu-paper-icon-item-1, tp-yt-paper-icon-item:has-text("Content"), a[href*="/videos"]'
          )
          .first();
        if (await contentNav.isVisible().catch(() => false)) {
          await contentNav.click({ timeout: 6000 }).catch(() => {});
        }
      }

      await page
        .locator('ytcp-video-row, ytcp-video-section-content')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(2000);
    } else {
      await this.dismissAllUploadDialogs(page).catch(() => {});
      await page
        .locator('ytcp-video-row, ytcp-video-section-content')
        .first()
        .waitFor({ state: 'visible', timeout: 10000 })
        .catch(() => {});
    }

    const scanPrefix = scanId && scanId !== 'test' && scanId !== 'default' ? scanId.slice(0, 8) : null;
    const startTime = Date.now();
    let refreshCycle = 0;

    const readRowsFromDom = async (): Promise<YtContentVideoItem[]> => {
      return page
        .evaluate(() => {
          const rows = Array.from(document.querySelectorAll('ytcp-video-row'));
          const extracted: Array<{
            title: string;
            videoId: string;
            ytUrl: string;
            windowNumber: number | null;
            scanPrefix: string | null;
            visibility: string;
            restrictions: string;
            isReady: boolean;
            isProcessingSd: boolean;
            hasClaim: boolean;
          }> = [];

          for (const row of rows) {
            const titleEl = row.querySelector('#video-title, a#video-title') as HTMLElement | null;
            const title = (titleEl?.innerText || titleEl?.textContent || '').replace(/\s+/g, ' ').trim();

            let videoId = '';
            const anchors = Array.from(row.querySelectorAll('a[href]'));
            for (const a of anchors) {
              const href = a.getAttribute('href') || '';
              const m1 = href.match(/\/video\/([a-zA-Z0-9_-]{11})/);
              if (m1) {
                videoId = m1[1];
                break;
              }
              const m2 = href.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
              if (m2) {
                videoId = m2[1];
                break;
              }
              const m3 = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
              if (m3) {
                videoId = m3[1];
                break;
              }
            }
            if (!videoId) {
              const imgs = Array.from(row.querySelectorAll('img[src]'));
              for (const img of imgs) {
                const src = img.getAttribute('src') || (img as HTMLImageElement).src || '';
                const mThumb = src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
                if (mThumb) {
                  videoId = mThumb[1];
                  break;
                }
              }
            }
            if (!videoId) {
              const html = row.outerHTML || '';
              const mHtml =
                html.match(/\/video\/([a-zA-Z0-9_-]{11})/) ||
                html.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
              if (mHtml) videoId = mHtml[1];
            }

            const mTitle = title.match(/^cmt-([a-zA-Z0-9_-]+)-w(\d+)\b/i);
            const mWinFile = !mTitle ? title.match(/\bwin[-_\s]+(\d+)[-_\s]+f\d+/i) : null;
            const rowScanPrefix = mTitle ? mTitle[1] : null;
            const windowNumber = mTitle
              ? Number(mTitle[2])
              : mWinFile
                ? Number(mWinFile[1])
                : null;

            // Never skip a Draft row with a valid cmt-<prefix>-w<N> title even if YouTube Studio hasn't rendered <a href="/video/..."> yet!
            if (!videoId && windowNumber === null && !title) continue;
            const ytUrl = videoId ? `https://youtu.be/${videoId}` : '';

            const visLabelEl = row.querySelector(
              '#visibility-label, ytcp-video-list-cell-visibility #visibility-label, .tablecell-visibility #visibility-label'
            ) as HTMLElement | null;
            const visCell = row.querySelector(
              '.tablecell-visibility, ytcp-video-list-cell-visibility, #visibility-label'
            ) as HTMLElement | null;
            const restCell = row.querySelector(
              '.tablecell-restrictions, ytcp-video-list-cell-restrictions'
            ) as HTMLElement | null;
            const dateCell = row.querySelector(
              '.tablecell-date, ytcp-video-list-cell-date'
            ) as HTMLElement | null;

            const rowText = ((row as HTMLElement).innerText || row.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            const rawVisText = (
              visLabelEl?.innerText ||
              visCell?.innerText ||
              visLabelEl?.textContent ||
              visCell?.textContent ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim();
            const dateText = (dateCell?.innerText || dateCell?.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            const restrictions =
              (restCell?.innerText || restCell?.textContent || '').replace(/\s+/g, ' ').trim() ||
              (/copyright|claimed/i.test(rowText)
                ? 'Copyright'
                : /checking/i.test(rowText)
                  ? 'Checking...'
                  : 'None');

            // User rules:
            // 1. Unlisted video works even when Blocked -> "Unlisted (Blocked)" is ready!
            // 2. Draft video works ONLY while not blocked; if Draft is Blocked ("Draft (Blocked)") or if video is Private ("Private"),
            //    AI Studio shows "This video is private" unless we convert it to Unlisted!
            const isBlocked = /\bblocked\b/i.test(`${rawVisText} ${restrictions} ${rowText}`);
            const isChecking = /\bchecking\b/i.test(`${restrictions} ${rawVisText} ${dateText} ${rowText}`);
            const isDraft = /\b(draft|edit\s+draft)\b/i.test(`${rawVisText} ${rowText}`);
            const isPrivate = !isDraft && /\bprivate\b/i.test(rawVisText);
            const hasExplicitReadyVisibility = /\b(unlisted|private|public|draft)\b/i.test(rawVisText);

            // A video is ONLY still uploading/processing SD if it is actively uploading bytes ("Uploading X%")
            // or "Processing will begin shortly" / "Processing up to SD" AND is NOT yet in Unlisted, Draft, Checking, or Blocked state!
            const isActivelyUploadingOrPreSd =
              !isBlocked &&
              !isChecking &&
              !isDraft &&
              !hasExplicitReadyVisibility &&
              (/\buploading\s*\d*%?/i.test(`${rawVisText} ${dateText} ${rowText}`) ||
                /\bprocessing\s+(up\s+to\s+sd|sd|will\s+begin|video)\b/i.test(
                  `${rawVisText} ${dateText} ${rowText}`
                ) ||
                /\bpending\b/i.test(rawVisText));

            const visibility = isDraft
              ? isBlocked
                ? 'Draft (Blocked)'
                : isChecking
                  ? 'Draft (Checking)'
                  : 'Draft'
              : isPrivate
                ? isBlocked
                  ? 'Private (Blocked)'
                  : 'Private'
                : isBlocked
                  ? 'Unlisted (Blocked)'
                  : /unlisted/i.test(rawVisText) || /unlisted/i.test(rowText)
                    ? isChecking
                      ? 'Unlisted (Checking)'
                      : 'Unlisted'
                    : isChecking
                      ? 'Checking'
                      : /public/i.test(rawVisText)
                        ? 'Public'
                        : isActivelyUploadingOrPreSd
                          ? 'Processing SD'
                          : 'Unlisted';

            const isReadyForGemini = !isActivelyUploadingOrPreSd && !isPrivate && !(isDraft && isBlocked);

            const hasClaim =
              isBlocked || /\b(copyright|claimed|blocked)\b/i.test(`${restrictions} ${rowText}`);

            extracted.push({
              title: title || videoId,
              videoId,
              ytUrl,
              windowNumber,
              scanPrefix: rowScanPrefix,
              visibility,
              restrictions,
              isReady: isReadyForGemini,
              isProcessingSd: !isReadyForGemini,
              hasClaim,
            });
          }

          return extracted;
        })
        .catch(() => []);
    };

    const matchesExpectedWindow = (
      exp: { windowNumber: number; clipPath?: string; title?: string; videoId?: string },
      item: YtContentVideoItem
    ): boolean => {
      // Strictly reject videos whose cmt-<prefix>-w<N> title belongs to a DIFFERENT scan!
      if (
        scanPrefix &&
        item.scanPrefix &&
        item.scanPrefix.toLowerCase() !== scanPrefix.toLowerCase()
      ) {
        return false;
      }
      if (exp.videoId && item.videoId && exp.videoId === item.videoId) return true;
      if (exp.title && item.title && exp.title.toLowerCase() === item.title.toLowerCase()) return true;
      if (
        exp.windowNumber === item.windowNumber &&
        (!scanPrefix || !item.scanPrefix || item.scanPrefix.toLowerCase() === scanPrefix.toLowerCase())
      ) {
        return true;
      }
      return false;
    };

    const syncSidecarsForItems = (items: YtContentVideoItem[]) => {
      for (const item of items) {
        if (!item.videoId || !item.ytUrl) continue;
        // 1. Check explicit expectedWindows list (strictly filtered by matchesExpectedWindow so cross-scan items never pollute)
        for (const exp of expectedWindows) {
          if (matchesExpectedWindow(exp, item)) {
            if (exp.clipPath && fs.existsSync(exp.clipPath)) {
              saveClipYtSidecar(exp.clipPath, {
                scanId: scanId || item.scanPrefix || 'scan',
                windowNumber: exp.windowNumber,
                ytUrl: item.ytUrl,
                ytVideoId: item.videoId,
                ytUploadedAt: Date.now(),
                ytDeleted: false,
              });
            }
          }
        }
        // 2. Also auto-match any clip file in the matching scan's clips folder ONLY (never write scan B's video into scan A!)
        if (item.windowNumber !== null && (item.scanPrefix || scanId)) {
          try {
            if (fs.existsSync(MEDIA_DIR)) {
              const scanDirs = fs
                .readdirSync(MEDIA_DIR)
                .filter((d) => {
                  if (item.scanPrefix) {
                    return d.toLowerCase().startsWith(item.scanPrefix.toLowerCase());
                  }
                  return d === scanId;
                });
              for (const sDir of scanDirs) {
                const clipsFolder = path.join(MEDIA_DIR, sDir, 'clips');
                if (!fs.existsSync(clipsFolder)) continue;
                const prefix = `win-${item.windowNumber}-`;
                const mp4s = fs
                  .readdirSync(clipsFolder)
                  .filter((f) => f.startsWith(prefix) && f.endsWith('.mp4'));
                for (const mp4 of mp4s) {
                  saveClipYtSidecar(path.join(clipsFolder, mp4), {
                    scanId: sDir,
                    windowNumber: item.windowNumber,
                    ytUrl: item.ytUrl,
                    ytVideoId: item.videoId,
                    ytUploadedAt: Date.now(),
                    ytDeleted: false,
                  });
                }
              }
            }
          } catch {
            // ignore sidecar auto-sync error
          }
        }
      }
    };

    while (true) {
      let allItems = await readRowsFromDom();
      if (allItems.length === 0 && refreshCycle === 0 && page.url().includes('/videos')) {
        await page.waitForTimeout(3000);
        allItems = await readRowsFromDom();
      }

      // Auto-convert any Draft (especially Draft Blocked / Draft) or Private rows belonging to this scan into Unlisted!
      const draftOrPrivateRows = allItems.filter((it) => {
        const belongsToScan =
          expectedWindows.length > 0
            ? expectedWindows.some((exp) => matchesExpectedWindow(exp, it))
            : scanPrefix
              ? !it.scanPrefix || it.scanPrefix.toLowerCase() === scanPrefix.toLowerCase()
              : true;
        if (!belongsToScan) return false;
        return /\b(draft|private)\b/i.test(it.visibility);
      });

      if (draftOrPrivateRows.length > 0 && !this.stopRequested) {
        for (const dpItem of draftOrPrivateRows) {
          if (this.stopRequested) break;
          this.log(
            'auto-unlist draft/private',
            `Converting "${dpItem.title}" (${dpItem.visibility}) -> Unlisted on Channel Content...`,
            'warn'
          );
          await this.convertVideoRowToUnlistedOnContentPage(page, {
            videoId: dpItem.videoId,
            title: dpItem.title,
            windowNumber: dpItem.windowNumber ?? undefined,
            scanPrefix: dpItem.scanPrefix || scanPrefix || undefined,
          }).catch(() => {});
        }
        allItems = await readRowsFromDom();
      }

      syncSidecarsForItems(allItems);

      // Filter relevant items strictly for this scan (never count another scan's cmt-<other>-w<N> videos!)
      const relevantItems =
        expectedWindows.length > 0
          ? allItems.filter((it) => expectedWindows.some((exp) => matchesExpectedWindow(exp, it)))
          : scanPrefix
            ? allItems.filter(
                (it) => !it.scanPrefix || it.scanPrefix.toLowerCase() === scanPrefix.toLowerCase()
              )
            : allItems;

      const expectedCount =
        expectedWindows.length > 0 ? expectedWindows.length : relevantItems.length;
      const uploadedCount = relevantItems.length;
      const readyCount = relevantItems.filter((it) => it.isReady).length;
      const processingCount = relevantItems.filter((it) => it.isProcessingSd).length;
      const claimedCount = relevantItems.filter((it) => it.hasClaim).length;
      const allReady =
        expectedCount > 0
          ? uploadedCount >= expectedCount && readyCount >= expectedCount && processingCount === 0
          : uploadedCount > 0 && processingCount === 0;

      const summary: YtContentProgressSummary = {
        checkedAt: Date.now(),
        totalInContent: allItems.length,
        expectedCount,
        uploadedCount,
        readyCount,
        processingCount,
        claimedCount,
        allReady,
        items: relevantItems,
      };

      this.contentProgress = summary;
      onProgress?.(summary);

      // Always log progress on initial check and on every 15-second refresh cycle so user sees live 15s updates
      const linksPreview = summary.items
        .slice(0, 3)
        .map((i) => `${i.title}->${i.ytUrl}`)
        .join(', ');
      this.log(
        'content progress',
        `Content${refreshCycle > 0 ? ` (check #${refreshCycle + 1})` : ''}: ${uploadedCount}/${expectedCount || uploadedCount} uploaded · ${readyCount}/${expectedCount || uploadedCount} SD ready (Unlisted)${processingCount > 0 ? ` · ${processingCount} processing SD` : ''}${claimedCount > 0 ? ` · ${claimedCount} claimed/blocked (treated as Unlisted)` : ''}${linksPreview ? ` [${linksPreview}]` : ''}`,
        allReady ? 'ok' : 'info'
      );

      // Do not loop forever if 0 videos on the page are processing SD!
      // If processingCount === 0 and tableConfirmedLoaded (or refreshCycle >= 1), all uploaded videos on the channel are already Ready,
      // and any remaining expectedCount - uploadedCount videos are missing from the channel and need to be uploaded rather than waited on.
      const noVideosProcessingSd =
        processingCount === 0 && (page.url().includes('/videos') || refreshCycle >= 1);

      if (
        this.stopRequested ||
        !waitForSdReady ||
        allReady ||
        noVideosProcessingSd ||
        (maxWaitMs > 0 && Date.now() - startTime >= maxWaitMs)
      ) {
        break;
      }

      // Wait 15 seconds (checking stopRequested every 1s) then refresh Content page to check SD processing
      for (let w = 0; w < 15; w++) {
        if (this.stopRequested) break;
        await page.waitForTimeout(1000);
      }
      if (this.stopRequested) break;

      refreshCycle++;
      this.log(
        'content refresh',
        `Refreshing YouTube Studio Content page (15s check #${refreshCycle}) — ${readyCount}/${expectedCount || uploadedCount} SD ready, ${processingCount} still processing SD...`,
        'info'
      );
      if (page.url().includes('d=ud') || !page.url().includes('/videos/upload')) {
        await page.goto(contentUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      }
      await page
        .locator('ytcp-video-row')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(2000);
      await this.dismissAllUploadDialogs(page).catch(() => {});
    }

    return this.contentProgress!;
  }

  async deleteAllChannelVideos(username = 'admin'): Promise<{ deletedBatches: number; message: string }> {
    return this.withLock(async () => {
      this.status = 'deleting';
      const page = await this.ensurePage(username);

      await page.goto('https://studio.youtube.com', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.waitForTimeout(3000);

      if (page.url().includes('accounts.google.com')) {
        throw new Error('Cannot delete channel videos: YT Studio is logged out.');
      }

      const ch = await this.verifyOrLockChannel(page, username);
      if (ch.channelId) {
        await page.goto(`https://studio.youtube.com/channel/${ch.channelId}/videos/upload`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        await page.waitForTimeout(3500);
      } else {
        // Fallback: click Content in left sidebar
        const contentNav = page.locator('a#menu-paper-icon-item-1, tp-yt-paper-icon-item:has-text("Content"), a[href*="/videos"]').first();
        if (await contentNav.isVisible().catch(() => false)) {
          await contentNav.click({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
      }

      // Re-verify locked channel on Content page
      await this.verifyOrLockChannel(page, username);

      const clickVisibleBySelectorsOrText = async (
        stepName: string,
        selectors: string[],
        exactTexts: string[],
        partialTexts: string[] = []
      ): Promise<boolean> => {
        // 1. Try visible Playwright locators with valid bounding box
        for (const sel of selectors) {
          try {
            const loc = page.locator(sel);
            const count = await loc.count().catch(() => 0);
            for (let i = 0; i < count; i++) {
              const item = loc.nth(i);
              if (await item.isVisible().catch(() => false)) {
                const box = await item.boundingBox().catch(() => null);
                if (box && box.width > 2 && box.height > 2) {
                  await item.click({ timeout: 5000 }).catch(async () => {
                    await page.mouse.click(
                      Math.round(box.x + box.width / 2),
                      Math.round(box.y + box.height / 2)
                    );
                  });
                  this.log('cleanup', `[${stepName}] Clicked via selector "${sel}" (#${i})`, 'info');
                  return true;
                }
              }
            }
          } catch {
            // continue to next selector
          }
        }

        // 2. Fallback: find visible element in DOM by text or aria-label and click its center coordinates
        const pt = await page
          .evaluate(
            ({ exactList, partialList }) => {
              const isVis = (el: Element): { ok: boolean; rect: DOMRect } => {
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                if (
                  style.display === 'none' ||
                  style.visibility === 'hidden' ||
                  parseFloat(style.opacity || '1') === 0 ||
                  r.width < 4 ||
                  r.height < 4
                ) {
                  return { ok: false, rect: r };
                }
                return { ok: true, rect: r };
              };

              const candidates = Array.from(
                document.querySelectorAll(
                  'ytcp-select, ytcp-text-dropdown-trigger, ytcp-dropdown-trigger, ytcp-button, tp-yt-paper-item, ytcp-text-menu-item, ytcp-ve, button, [role="button"], [role="menuitem"], [role="option"], [role="checkbox"], ytcp-checkbox-lit, span, div, a'
                )
              );

              // First pass: exact text match (prefer smallest visible bounding box so we hit the actual control, not a full-page wrapper)
              let best: { x: number; y: number; area: number; label: string } | null = null;
              for (const el of candidates) {
                const { ok, rect } = isVis(el);
                if (!ok) continue;
                const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                for (const target of exactList) {
                  const t = target.toLowerCase();
                  if (txt === t || aria === t) {
                    const area = rect.width * rect.height;
                    if (area < 150000 && (!best || area < best.area)) {
                      best = {
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2),
                        area,
                        label: txt || aria,
                      };
                    }
                  }
                }
              }
              if (best) return best;

              // Second pass: partial text match
              for (const el of candidates) {
                const { ok, rect } = isVis(el);
                if (!ok) continue;
                const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                for (const target of partialList) {
                  const t = target.toLowerCase();
                  if ((txt && txt.includes(t)) || (aria && aria.includes(t))) {
                    const area = rect.width * rect.height;
                    if (area < 120000 && (!best || area < best.area)) {
                      best = {
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2),
                        area,
                        label: txt.slice(0, 40) || aria.slice(0, 40),
                      };
                    }
                  }
                }
              }
              return best;
            },
            { exactList: exactTexts, partialList: partialTexts }
          )
          .catch(() => null);

        if (pt) {
          await page.mouse.click(pt.x, pt.y);
          this.log('cleanup', `[${stepName}] Clicked via coordinates (${pt.x}, ${pt.y}) "${pt.label}"`, 'info');
          return true;
        }

        return false;
      };

      let deletedBatches = 0;
      const rowCount = await page.locator('ytcp-video-row').count().catch(() => 0);
      if (rowCount === 0) {
        this.log('cleanup', 'No videos remaining on locked YT Studio channel', 'ok');
      } else {
        this.log('cleanup', `Deleting ${rowCount} visible video row(s) on channel...`, 'info');
        await this.dismissAllUploadDialogs(page).catch(() => {});
        await page.waitForTimeout(2000);

        // 1. Click Select-All checkbox in the table header
        const selectedAll = await clickVisibleBySelectorsOrText(
          'Select All',
          [
            'ytcp-table-header #selection-checkbox',
            '#selection-checkbox',
            'ytcp-checkbox-lit#selection-checkbox',
            'ytcp-video-section-content #selection-checkbox',
          ],
          ['Select all'],
          ['Select all']
        );

        if (!selectedAll) {
          await this.dumpFailureScreenshot(page, 'delete-no-selectall');
          throw new Error('Select-all checkbox not found on YT Studio Content table.');
        }
        await page.waitForTimeout(2000);

        // 2. Click "More actions" dropdown in the black bulk-actions bar
        const openedMoreActions = await clickVisibleBySelectorsOrText(
          'More actions',
          [
            'ytcp-bulk-actions ytcp-select:has-text("More actions")',
            'ytcp-bulk-actions ytcp-text-dropdown-trigger:has-text("More actions")',
            'ytcp-bulk-actions ytcp-dropdown-trigger:has-text("More actions")',
            'ytcp-bulk-actions :text-is("More actions")',
            'ytcp-select:has-text("More actions")',
            'ytcp-text-dropdown-trigger:has-text("More actions")',
            'ytcp-dropdown-trigger:has-text("More actions")',
            '#additional-action-options',
            '#additional-action-options-button',
            'ytcp-button:has-text("More actions")',
          ],
          ['More actions'],
          ['More actions']
        );

        if (!openedMoreActions) {
          await this.dumpFailureScreenshot(page, 'delete-no-moreactions');
          throw new Error('More actions dropdown not found in YT Studio bulk action bar.');
        }
        await page.waitForTimeout(2000);

        // 3. Click "Delete forever" item in the dropdown menu
        const clickedDeleteForeverMenu = await clickVisibleBySelectorsOrText(
          'Delete forever (menu)',
          [
            'tp-yt-paper-listbox tp-yt-paper-item:has-text("Delete forever")',
            'tp-yt-paper-item:has-text("Delete forever")',
            'ytcp-text-menu-item:has-text("Delete forever")',
            'ytcp-ve:has-text("Delete forever")',
            '[role="option"]:has-text("Delete forever")',
            '[role="menuitem"]:has-text("Delete forever")',
          ],
          ['Delete forever'],
          ['Delete forever']
        );

        if (!clickedDeleteForeverMenu) {
          await this.dumpFailureScreenshot(page, 'delete-no-menuitem');
          throw new Error('Delete forever menu option not found after opening More actions.');
        }
        await page.waitForTimeout(2000);

        // 4. Click "I understand that deleting is permanent and can't be undone" checkbox in the confirmation dialog
        const clickedConfirmCheckbox = await clickVisibleBySelectorsOrText(
          'Confirm permanent delete checkbox',
          [
            'ytcp-confirmation-dialog #confirm-checkbox',
            'ytcp-confirmation-dialog ytcp-checkbox-lit',
            'ytcp-confirmation-dialog [role="checkbox"]',
            'tp-yt-paper-dialog #confirm-checkbox',
            'tp-yt-paper-dialog ytcp-checkbox-lit',
            'tp-yt-paper-dialog [role="checkbox"]',
            '#confirm-checkbox',
          ],
          [
            "I understand that deleting is permanent and can't be undone",
            'I understand that deleting is permanent and cannot be undone',
          ],
          ['I understand that deleting', 'permanently deleted']
        );

        if (!clickedConfirmCheckbox) {
          await this.dumpFailureScreenshot(page, 'delete-no-confirmcheckbox');
          throw new Error('Confirmation checkbox not found in YT Studio Delete forever dialog.');
        }
        await page.waitForTimeout(2000);

        // 5. Click final "Delete forever" button inside the confirmation dialog
        const clickedConfirmButton = await clickVisibleBySelectorsOrText(
          'Confirm Delete forever button',
          [
            'ytcp-confirmation-dialog #confirm-button',
            'tp-yt-paper-dialog #confirm-button',
            'ytcp-dialog #confirm-button',
            'ytcp-confirmation-dialog ytcp-button:has-text("Delete forever")',
            'tp-yt-paper-dialog ytcp-button:has-text("Delete forever")',
            '#confirm-button:has-text("Delete forever")',
            'ytcp-button#confirm-button',
          ],
          ['Delete forever', 'Delete'],
          ['Delete forever']
        );

        if (!clickedConfirmButton) {
          await this.dumpFailureScreenshot(page, 'delete-no-confirmbtn');
          throw new Error('Confirm Delete forever button not found in YT Studio dialog.');
        }

        // Wait 2s for the click request to dispatch; YouTube Studio processes deletion automatically in background
        await page.waitForTimeout(2000);
        deletedBatches = 1;
        this.log(
          'cleanup',
          `Delete forever submitted (${rowCount} video(s)) — YouTube Studio is deleting in background, continuing immediately.`,
          'ok'
        );
      }

      // Mark all cached window clip YT sidecars on disk as deleted so subsequent scans don't reuse deleted links
      const invalidatedSidecars = markAllChannelClipsYtDeleted();
      this.uploadedVideoIdsInSession.clear();
      this.contentProgress = null;

      this.status = 'ready';
      const msg = deletedBatches > 0
        ? `Delete forever triggered for locked channel ${ch.channelHandle || ch.channelId || ''} (${rowCount} video(s), cleared ${invalidatedSidecars} cached link(s))`
        : `Channel is already clean (0 videos found${invalidatedSidecars > 0 ? `, cleared ${invalidatedSidecars} stale cached link(s)` : ''})`;
      this.log('cleanup done', msg, 'ok');
      return { deletedBatches, message: msg };
    });
  }

  async toggleAssistMode(enable?: boolean, username = 'admin'): Promise<boolean> {
    this.assistMode = typeof enable === 'boolean' ? enable : !this.assistMode;
    if (this.assistMode) {
      this.status = 'assist';
      const page = await this.ensurePage(username);
      await this.applySavedCookiesToContext(username).catch(() => {});
      if (page.url() === 'about:blank') {
        await page.goto('https://studio.youtube.com', {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        }).catch(() => {});
      }
      this.log('assist mode', 'Interactive Login Assist enabled for YouTube Studio', 'info');
    } else {
      this.status = 'ready';
      if (this.page && !this.page.isClosed() && this.page.url().startsWith('https://studio.youtube.com')) {
        await this.saveSessionFromContext(username).catch(() => {});
      }
      this.log('assist mode', 'Interactive Login Assist disabled (session saved)', 'info');
    }
    return this.assistMode;
  }

  pause(): void {
    this.paused = true;
    this.status = 'paused';
    this.log('control', 'Paused YouTube Studio controller', 'warn');
  }

  resume(): void {
    this.paused = false;
    this.status = this.assistMode ? 'assist' : 'ready';
    this.log('control', 'Resumed YouTube Studio controller', 'info');
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.paused = false;
    this.assistMode = false;
    this.status = 'idle';
    this.log('control', 'Stopping and closing YouTube Studio browser...', 'warn');
    await this.close();
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close().catch(() => {});
      }
    } finally {
      this.context = null;
      this.page = null;
      this.status = 'idle';
    }
  }

  async switchTab(tabIndex: number): Promise<void> {
    if (!this.context) return;
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (tabIndex >= 0 && tabIndex < pages.length) {
      this.page = pages[tabIndex];
      this.manualTabSelection = true;
      await this.page.setViewportSize(this.viewport).catch(() => {});
      await this.page.bringToFront().catch(() => {});
      this.log('switch tab', `Switched to Tab #${tabIndex + 1}: ${this.page.url()}`, 'info');
    }
  }

  async clickVerifyNext(username = 'admin'): Promise<void> {
    const page = await this.ensurePage(username);
    if (!this.context) return;
    const pagesBefore = this.context.pages().filter((p) => !p.isClosed()).length;

    const popupPromise = this.context.waitForEvent('page', { timeout: 5000 }).catch(() => null);

    const verifySelectors = [
      'tp-yt-paper-dialog:has-text("Verify it\'s you") ytcp-button:has-text("Next")',
      'tp-yt-paper-dialog:has-text("Verify it\'s you") #confirm-button',
      'ytcp-verify-user-dialog ytcp-button:has-text("Next")',
      'ytcp-dialog ytcp-button:has-text("Next")',
      'tp-yt-paper-dialog button:has-text("Next")',
      'button:has-text("Next")',
      'span:has-text("Next")',
    ];

    let clicked = false;
    for (const sel of verifySelectors) {
      const loc = page.locator(sel).last();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 4000 }).catch(() => {});
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await page.keyboard.press('Enter').catch(() => {});
    }

    const popup = await popupPromise;
    if (popup) {
      await popup.setViewportSize(this.viewport).catch(() => {});
      await popup.bringToFront().catch(() => {});
      this.page = popup;
      this.manualTabSelection = false;
      await popup.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      this.log('verify popup', `Opened Google verification window: ${popup.url()}`, 'ok');
      return;
    }

    this.syncActivePopupPageIfNeeded();
    const pagesAfter = this.context.pages().filter((p) => !p.isClosed()).length;
    this.log(
      'verify next',
      `Clicked Next on verification dialog (tabs: ${pagesBefore} -> ${pagesAfter}, url=${this.page?.url() || ''})`,
      'ok'
    );
  }

  async handleClick(x: number, y: number, username = 'admin'): Promise<void> {
    const page = await this.ensurePage(username);
    if (this.context) {
      this.bindContextPopupListeners(this.context);
    }
    const pagesBefore = this.context ? this.context.pages().filter((p) => !p.isClosed()).length : 1;

    // Watch briefly in case this click opens a popup (e.g. "Verify it's you" -> "Next")
    const popupWait = this.context
      ? this.context.waitForEvent('page', { timeout: 1800 }).catch(() => null)
      : Promise.resolve(null);

    await page.mouse.click(x, y);
    this.log('assist click', `Clicked (${Math.round(x)}, ${Math.round(y)})`, 'info');

    // Also check if "Verify it's you" dialog is visible and click landed near Next
    const verifyDialogVisible = await page
      .locator('tp-yt-paper-dialog:has-text("Verify it\'s you"), ytcp-verify-user-dialog')
      .first()
      .isVisible()
      .catch(() => false);

    let popup = await popupWait;

    if (!popup && verifyDialogVisible && x >= 760 && x <= 1020 && y >= 400 && y <= 620) {
      const nextBtn = page
        .locator(
          'tp-yt-paper-dialog:has-text("Verify it\'s you") ytcp-button:has-text("Next"), tp-yt-paper-dialog:has-text("Verify it\'s you") #confirm-button, ytcp-verify-user-dialog ytcp-button:has-text("Next"), tp-yt-paper-dialog button:has-text("Next")'
        )
        .last();
      if (await nextBtn.isVisible().catch(() => false)) {
        const popupWait2 = this.context
          ? this.context.waitForEvent('page', { timeout: 3500 }).catch(() => null)
          : Promise.resolve(null);
        await nextBtn.click({ force: true }).catch(() => {});
        popup = await popupWait2;
      }
    }

    if (popup) {
      await popup.setViewportSize(this.viewport).catch(() => {});
      await popup.bringToFront().catch(() => {});
      this.page = popup;
      this.manualTabSelection = false;
      await popup.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      this.log(
        'popup opened',
        `Switched live screen to verification popup: ${popup.url() || 'loading...'}`,
        'ok'
      );
    } else if (this.context) {
      const openNow = this.context.pages().filter((p) => !p.isClosed());
      if (openNow.length > pagesBefore) {
        const newest = openNow[openNow.length - 1];
        await newest.setViewportSize(this.viewport).catch(() => {});
        this.page = newest;
        this.manualTabSelection = false;
        this.log('popup opened', `Switched to new tab: ${newest.url()}`, 'ok');
      } else {
        await page.waitForTimeout(350);
      }
    }
  }

  async handleType(text: string, username = 'admin'): Promise<void> {
    const page = await this.ensurePage(username);
    await page.keyboard.type(text, { delay: 20 });
    this.log('assist type', `Typed ${text.length} char(s)`, 'info');
  }

  async handleKey(key: string, username = 'admin'): Promise<void> {
    const page = await this.ensurePage(username);
    await page.keyboard.press(key);
    this.log('assist key', `Pressed ${key}`, 'info');
  }

  async handleNavigate(url: string, username = 'admin'): Promise<void> {
    const page = await this.ensurePage(username);
    const target = url.startsWith('http') ? url : `https://${url}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    this.log('assist navigate', target, 'info');
  }

  async getScreenshotJpeg(): Promise<Buffer | null> {
    this.syncActivePopupPageIfNeeded();
    if (!this.page || this.page.isClosed()) return null;
    try {
      return await this.page.screenshot({ type: 'jpeg', quality: 65 });
    } catch {
      return null;
    }
  }

  async getSnapshot(includeScreenshot = false): Promise<YtControllerSnapshot> {
    this.syncActivePopupPageIfNeeded();
    let screenshotBase64: string | null = null;
    if (includeScreenshot && this.page && !this.page.isClosed()) {
      const buf = await this.getScreenshotJpeg();
      if (buf) {
        screenshotBase64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    }
    const openTabs: YtOpenTabInfo[] = this.context
      ? this.context
          .pages()
          .filter((p) => !p.isClosed())
          .map((p, idx) => ({
            index: idx,
            url: p.url() || 'about:blank',
            active: p === this.page,
          }))
      : [];

    this.syncLogsFromDiskIfNeeded();
    return {
      status: this.status,
      assistMode: this.assistMode,
      currentStep: this.currentStep,
      currentUrl: this.page && !this.page.isClosed() ? this.page.url() : '',
      channelId: this.channelId,
      channelHandle: this.channelHandle,
      logs: this.logs.slice(0, 500),
      lastError: this.lastError,
      screenshotBase64,
      viewport: this.viewport,
      openTabs,
      contentProgress: this.contentProgress || null,
    };
  }
}

function getGlobalYtStudioController(): YtStudioBrowserController {
  const g = globalThis as unknown as { __cmtYtStudioController?: YtStudioBrowserController };
  if (!g.__cmtYtStudioController) {
    g.__cmtYtStudioController = new YtStudioBrowserController();
  } else {
    Object.setPrototypeOf(g.__cmtYtStudioController, YtStudioBrowserController.prototype);
  }
  return g.__cmtYtStudioController;
}

export const globalYtStudioController = getGlobalYtStudioController();
