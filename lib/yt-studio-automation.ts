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
import {
  readClipYtSidecar,
  saveClipYtSidecar,
} from './studio-window-clips';

export interface YtStepLog {
  ts: number;
  step: string;
  detail: string;
  status: 'info' | 'ok' | 'warn' | 'error';
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
}

class GlobalYtStudioUploadGate {
  private active = 0;
  private maxConcurrent = 3;
  private queue: Array<() => void> = [];

  setMaxConcurrent(n: number): void {
    const clamped = Math.max(1, Math.min(5, Math.floor(Number(n) || 3)));
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

  private log(step: string, detail: string, status: YtStepLog['status'] = 'info'): void {
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
    if (this.logs.length > 200) {
      this.logs.length = 200;
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

  async ensurePage(username = 'admin'): Promise<Page> {
    if (this.page && !this.page.isClosed() && this.context) {
      return this.page;
    }
    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      this.status = 'starting';
      this.log('browser', 'Launching isolated YouTube Studio browser profile...', 'info');
      const { chromium } = await import('playwright');
      const profileDir = this.getProfileDir();
      cleanStaleSingletonLocks(profileDir);

      const executablePath = resolveSystemChromePath();
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        `--window-size=${this.viewport.width},${this.viewport.height}`,
      ];

      const hasDisplay = Boolean(process.env.DISPLAY);
      const context = await chromium.launchPersistentContext(profileDir, {
        headless: !hasDisplay,
        executablePath,
        viewport: this.viewport,
        args,
      });

      this.context = context;
      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();
      await page.setViewportSize(this.viewport).catch(() => {});
      this.page = page;

      await this.applySavedCookiesToContext(username);

      this.status = this.assistMode ? 'assist' : 'ready';
      this.log('browser', 'YouTube Studio browser ready', 'ok');
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
    try {
      await this.context.addCookies(cookies);
      this.log('cookies', `Applied ${cookies.length} saved YouTube/Google cookies`, 'ok');
      return cookies.length;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('cookies', `Cookie injection warning: ${msg}`, 'warn');
      return 0;
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

    if (cfg.ytChannelId && detected.channelId && cfg.ytChannelId !== detected.channelId) {
      const msg = `Channel safety lock mismatch! Expected channel ID ${cfg.ytChannelId} (${cfg.ytChannelHandle || 'locked'}), but browser is on ${detected.channelId} (${detected.channelHandle || 'unknown'}). Aborting operation.`;
      this.log('channel lock', msg, 'error');
      throw new Error(msg);
    }

    if (!cfg.ytChannelId && (detected.channelId || detected.channelHandle)) {
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
      channelId: detected.channelId || cfg.ytChannelId,
      channelHandle: detected.channelHandle || cfg.ytChannelHandle,
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
    return this.withLock(async () => {
      const page = await this.ensurePage(username);
      await this.applySavedCookiesToContext(username);

      this.log('test login', 'Navigating to https://studio.youtube.com ...', 'info');
      await page.goto('https://studio.youtube.com', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await page.waitForTimeout(3500);

      const url = page.url();
      const isAuthWall =
        url.includes('accounts.google.com') ||
        url.includes('ServiceLogin') ||
        url.includes('signin');

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
    });
  }

  async uploadWindowClip(opts: {
    clipPath: string;
    scanId: string;
    windowNumber: number;
    visibility?: 'unlisted' | 'private';
    username?: string;
    onProgress?: (stage: string) => void;
  }): Promise<{ ytUrl: string; ytVideoId: string; reused: boolean }> {
    const {
      clipPath,
      scanId,
      windowNumber,
      visibility = 'unlisted',
      username = 'admin',
      onProgress,
    } = opts;

    const existing = readClipYtSidecar(clipPath);
    if (existing && existing.ytUrl && existing.ytVideoId && !existing.ytDeleted) {
      this.log(
        'sidecar hit',
        `Reusing cached YouTube link for W${String(windowNumber).padStart(2, '0')}: ${existing.ytUrl}`,
        'ok'
      );
      onProgress?.('link ready');
      return {
        ytUrl: existing.ytUrl,
        ytVideoId: existing.ytVideoId,
        reused: true,
      };
    }

    if (!fs.existsSync(clipPath)) {
      throw new Error(`Clip file not found at ${clipPath}`);
    }

    const title = `cmt-${scanId.slice(0, 8)}-w${windowNumber}`;
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await this.withLock(async () => {
          this.status = 'uploading';
          onProgress?.('uploading to YT');
          const page = await this.ensurePage(username);

          if (!page.url().startsWith('https://studio.youtube.com')) {
            await page.goto('https://studio.youtube.com', {
              waitUntil: 'domcontentloaded',
              timeout: 45000,
            });
            await page.waitForTimeout(3000);
          } else {
            await page.bringToFront().catch(() => {});
          }

          if (page.url().includes('accounts.google.com')) {
            throw new Error('YT Studio session logged out — redirected to accounts.google.com');
          }

          await this.verifyOrLockChannel(page, username);

          this.log(
            'upload start',
            `[W${String(windowNumber).padStart(2, '0')}] Uploading ${path.basename(clipPath)} as "${title}" (attempt ${attempt}/2)`,
            'info'
          );

          // Dismiss any leftover upload dialog first
          const closeDialogBtn = page.locator('ytcp-uploads-dialog #close-button, ytcp-uploads-mini-indicator #close-button').first();
          if (await closeDialogBtn.isVisible().catch(() => false)) {
            await closeDialogBtn.click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(600);
          }

          // Step 1: Click Create -> Upload videos (or direct file input if already present)
          let fileInput = page.locator('input[type="file"][name="Filedata"], ytcp-uploads-file-picker input[type="file"], input[type="file"]').first();
          if (!(await fileInput.count())) {
            const createSelectors = [
              '#create-icon',
              'ytcp-button#create-icon',
              'button[aria-label="Create"]',
              'ytcp-icon-button[aria-label="Create"]',
              'button:has-text("Create")',
            ];
            let clickedCreate = false;
            for (const sel of createSelectors) {
              const loc = page.locator(sel).first();
              if (await loc.isVisible().catch(() => false)) {
                await loc.click({ timeout: 6000 });
                clickedCreate = true;
                break;
              }
            }
            if (!clickedCreate) {
              const directUploadBtn = page.locator('#upload-icon, ytcp-button#upload-icon, button[aria-label="Upload videos"]').first();
              if (await directUploadBtn.isVisible().catch(() => false)) {
                await directUploadBtn.click({ timeout: 6000 });
              }
            } else {
              await page.waitForTimeout(700);
              const uploadMenuSelectors = [
                'tp-yt-paper-item#text-item-0',
                'tp-yt-paper-item:has-text("Upload videos")',
                'ytcp-ve:has-text("Upload videos")',
                '[ role="menuitem" ]:has-text("Upload videos")',
              ];
              for (const sel of uploadMenuSelectors) {
                const item = page.locator(sel).first();
                if (await item.isVisible().catch(() => false)) {
                  await item.click({ timeout: 6000 });
                  break;
                }
              }
            }
            await page.waitForTimeout(1000);
            fileInput = page.locator('input[type="file"][name="Filedata"], ytcp-uploads-file-picker input[type="file"], input[type="file"]').first();
          }

          await fileInput.waitFor({ state: 'attached', timeout: 15000 });
          await fileInput.setInputFiles(clipPath);
          this.log('upload file', `Attached ${path.basename(clipPath)} to YT Studio file picker`, 'info');

          // Wait for the upload details modal to open
          const titleBoxSelectors = [
            'ytcp-social-suggestions-textbox#title-textarea #textbox',
            '#title-textarea #textbox',
            'div#textbox[aria-label*="Add a title"]',
            'div#textbox[contenteditable="true"]',
          ];
          const titleBox = page.locator(titleBoxSelectors.join(', ')).first();
          await titleBox.waitFor({ state: 'visible', timeout: 30000 });
          await page.waitForTimeout(800);

          // Step 2: Set title
          await titleBox.click({ timeout: 5000 });
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          await titleBox.fill(title).catch(async () => {
            await page.keyboard.type(title, { delay: 15 });
          });

          // Step 3: Select "No, it's not made for kids"
          const notMfkSelectors = [
            'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
            '#audience tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
            'tp-yt-paper-radio-button:has-text("No, it\'s not made for kids")',
            'tp-yt-paper-radio-button:has-text("not made for kids")',
          ];
          for (const sel of notMfkSelectors) {
            const radio = page.locator(sel).first();
            if (await radio.isVisible().catch(() => false)) {
              await radio.scrollIntoViewIfNeeded().catch(() => {});
              await radio.click({ timeout: 5000 }).catch(() => {});
              break;
            }
          }

          // Extract the video URL / video ID as soon as it appears in the dialog
          const readShareUrlFromDialog = async (): Promise<string | null> => {
            try {
              const found = await page.evaluate(() => {
                const linkEls = Array.from(
                  document.querySelectorAll('a.style-scope.ytcp-video-info, a[href*="youtu.be/"], a[href*="youtube.com/watch"], a[href*="youtube.com/shorts/"]')
                );
                for (const el of linkEls) {
                  const href = (el as HTMLAnchorElement).href || el.textContent || '';
                  if (href.includes('youtu.be/') || href.includes('youtube.com/watch') || href.includes('youtube.com/shorts/')) {
                    return href.trim();
                  }
                }
                const text = document.body?.innerText || '';
                const m = text.match(/https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/);
                return m ? m[0] : null;
              });
              return found;
            } catch {
              return null;
            }
          };

          let shareUrl = await readShareUrlFromDialog();

          // Step 4: Click Next 3 times (Video elements -> Checks -> Visibility)
          const nextBtn = page.locator('#next-button, ytcp-button#next-button, button:has-text("Next")').first();
          for (let stepIdx = 0; stepIdx < 3; stepIdx++) {
            await page.waitForTimeout(700);
            if (!shareUrl) {
              shareUrl = await readShareUrlFromDialog();
            }
            if (await nextBtn.isVisible().catch(() => false)) {
              await nextBtn.click({ timeout: 8000 }).catch(() => {});
            }
          }

          await page.waitForTimeout(1000);

          // Step 5: Select Unlisted (or Private) radio button
          const targetRadioName = visibility === 'private' ? 'PRIVATE' : 'UNLISTED';
          const visSelectors = [
            `tp-yt-paper-radio-button[name="${targetRadioName}"]`,
            `#privacy-radios tp-yt-paper-radio-button[name="${targetRadioName}"]`,
            `tp-yt-paper-radio-button:has-text("${visibility === 'private' ? 'Private' : 'Unlisted'}")`,
          ];
          for (const sel of visSelectors) {
            const r = page.locator(sel).first();
            if (await r.isVisible().catch(() => false)) {
              await r.scrollIntoViewIfNeeded().catch(() => {});
              await r.click({ timeout: 5000 }).catch(() => {});
              break;
            }
          }

          // Wait until upload transfer reaches 100% / Save button is enabled and shareUrl is populated
          const deadline = Date.now() + 180_000;
          while (Date.now() < deadline) {
            if (!shareUrl) {
              shareUrl = await readShareUrlFromDialog();
            }
            const doneBtn = page.locator('#done-button, ytcp-button#done-button').first();
            const isDisabled = await doneBtn.getAttribute('disabled').catch(() => null);
            const progressText = await page
              .locator('ytcp-video-upload-progress, .progress-label')
              .first()
              .innerText()
              .catch(() => '');

            const stillUploading = /uploading\s+\d+%/i.test(progressText);
            if (shareUrl && !stillUploading && isDisabled === null) {
              break;
            }
            await page.waitForTimeout(1500);
          }

          if (!shareUrl) {
            shareUrl = await readShareUrlFromDialog();
          }

          // Click Save / Done button
          const doneBtn = page.locator('#done-button, ytcp-button#done-button, button:has-text("Save")').first();
          await doneBtn.click({ timeout: 15000 });
          await page.waitForTimeout(2000);

          if (!shareUrl) {
            shareUrl = await readShareUrlFromDialog();
          }

          // Close the share/published confirmation modal if visible
          const closeShareBtn = page.locator(
            'ytcp-uploads-still-processing-dialog #close-button, ytcp-video-share-dialog #close-button, ytcp-button#close-button, button[aria-label="Close"]'
          ).first();
          if (await closeShareBtn.isVisible().catch(() => false)) {
            await closeShareBtn.click({ timeout: 5000 }).catch(() => {});
          }

          if (!shareUrl) {
            throw new Error('Upload completed in dialog, but could not extract https://youtu.be/<id> share URL.');
          }

          const idMatch =
            shareUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
            shareUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
            shareUrl.match(/shorts\/([a-zA-Z0-9_-]{11})/);
          const ytVideoId = idMatch ? idMatch[1] : shareUrl;
          const normalizedUrl = idMatch ? `https://youtu.be/${idMatch[1]}` : shareUrl;

          saveClipYtSidecar(clipPath, {
            scanId,
            windowNumber,
            ytUrl: normalizedUrl,
            ytVideoId,
            ytUploadedAt: Date.now(),
            ytDeleted: false,
          });

          this.status = 'ready';
          onProgress?.('link ready');
          this.log(
            'upload complete',
            `[W${String(windowNumber).padStart(2, '0')}] Uploaded -> ${normalizedUrl}`,
            'ok'
          );

          return {
            ytUrl: normalizedUrl,
            ytVideoId,
            reused: false,
          };
        });

        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastErr = err instanceof Error ? err : new Error(msg);
        this.log(
          'upload error',
          `[W${String(windowNumber).padStart(2, '0')}] Attempt ${attempt}/2 failed: ${msg}`,
          'error'
        );
        await this.dumpFailureScreenshot(this.page, `upload-w${windowNumber}-a${attempt}`);
      }
    }

    this.status = 'error';
    throw lastErr || new Error(`Failed to upload window ${windowNumber} to YouTube Studio`);
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

      let deletedBatches = 0;
      for (let round = 1; round <= 20; round++) {
        const rowCount = await page.locator('ytcp-video-row').count().catch(() => 0);
        if (rowCount === 0) {
          this.log('cleanup', 'No videos remaining on locked YT Studio channel', 'ok');
          break;
        }

        this.log('cleanup', `Deleting batch #${round} (${rowCount} visible video rows)...`, 'info');

        const selectAllCheckbox = page.locator(
          '#selection-checkbox, ytcp-checkbox-lit#selection-checkbox, ytcp-video-section-content #selection-checkbox'
        ).first();

        if (!(await selectAllCheckbox.isVisible().catch(() => false))) {
          await this.dumpFailureScreenshot(page, `delete-no-selectall-r${round}`);
          throw new Error('Select-all checkbox not found on YT Studio Content table.');
        }

        await selectAllCheckbox.click({ timeout: 6000 });
        await page.waitForTimeout(800);

        const moreActionsBtn = page.locator(
          'ytcp-button:has-text("More actions"), #additional-action-options-button, button[aria-label="More actions"]'
        ).first();
        await moreActionsBtn.click({ timeout: 6000 });
        await page.waitForTimeout(600);

        const deleteForeverItem = page.locator(
          'tp-yt-paper-item:has-text("Delete forever"), ytcp-ve:has-text("Delete forever")'
        ).first();
        await deleteForeverItem.click({ timeout: 6000 });
        await page.waitForTimeout(1000);

        const confirmCheckbox = page.locator(
          'ytcp-confirmation-dialog ytcp-checkbox-lit, ytcp-dialog #confirm-checkbox, ytcp-checkbox-lit: near(:text("permanently deleted"))'
        ).first();
        await confirmCheckbox.click({ timeout: 6000 });
        await page.waitForTimeout(500);

        const confirmDeleteBtn = page.locator(
          'ytcp-confirmation-dialog #confirm-button, ytcp-dialog ytcp-button:has-text("Delete forever"), button:has-text("Delete forever")'
        ).first();
        await confirmDeleteBtn.click({ timeout: 8000 });

        deletedBatches++;
        this.log('cleanup', `Batch #${round} deletion submitted — waiting for YouTube Studio to finish...`, 'info');

        // Wait until rows clear or dialog closes
        const waitDeadline = Date.now() + 90_000;
        while (Date.now() < waitDeadline) {
          await page.waitForTimeout(2500);
          const dialogVisible = await page.locator('ytcp-confirmation-dialog').isVisible().catch(() => false);
          if (!dialogVisible) break;
        }
        await page.waitForTimeout(2000);
      }

      this.status = 'ready';
      const msg = deletedBatches > 0
        ? `Deleted ${deletedBatches} batch(es) of videos from locked channel ${ch.channelHandle || ch.channelId || ''}`
        : 'Channel is already clean (0 videos found)';
      this.log('cleanup done', msg, 'ok');
      return { deletedBatches, message: msg };
    });
  }

  async toggleAssistMode(enable?: boolean, username = 'admin'): Promise<boolean> {
    this.assistMode = typeof enable === 'boolean' ? enable : !this.assistMode;
    if (this.assistMode) {
      this.status = 'assist';
      const page = await this.ensurePage(username);
      if (page.url() === 'about:blank') {
        await page.goto('https://studio.youtube.com', {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        }).catch(() => {});
      }
      this.log('assist mode', 'Interactive Login Assist enabled for YouTube Studio', 'info');
    } else {
      this.status = 'ready';
      this.log('assist mode', 'Interactive Login Assist disabled', 'info');
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

  async handleClick(x: number, y: number, username = 'admin'): Promise<void> {
    const page = await this.ensurePage(username);
    await page.mouse.click(x, y);
    this.log('assist click', `Clicked (${Math.round(x)}, ${Math.round(y)})`, 'info');
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
    if (!this.page || this.page.isClosed()) return null;
    try {
      return await this.page.screenshot({ type: 'jpeg', quality: 65 });
    } catch {
      return null;
    }
  }

  async getSnapshot(includeScreenshot = false): Promise<YtControllerSnapshot> {
    let screenshotBase64: string | null = null;
    if (includeScreenshot && this.page && !this.page.isClosed()) {
      const buf = await this.getScreenshotJpeg();
      if (buf) {
        screenshotBase64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
      }
    }
    return {
      status: this.status,
      assistMode: this.assistMode,
      currentStep: this.currentStep,
      currentUrl: this.page && !this.page.isClosed() ? this.page.url() : '',
      channelId: this.channelId,
      channelHandle: this.channelHandle,
      logs: this.logs.slice(0, 80),
      lastError: this.lastError,
      screenshotBase64,
      viewport: this.viewport,
    };
  }
}

function getGlobalYtStudioController(): YtStudioBrowserController {
  const g = globalThis as unknown as { __cmtYtStudioController?: YtStudioBrowserController };
  if (!g.__cmtYtStudioController) {
    g.__cmtYtStudioController = new YtStudioBrowserController();
  }
  return g.__cmtYtStudioController;
}

export const globalYtStudioController = getGlobalYtStudioController();
