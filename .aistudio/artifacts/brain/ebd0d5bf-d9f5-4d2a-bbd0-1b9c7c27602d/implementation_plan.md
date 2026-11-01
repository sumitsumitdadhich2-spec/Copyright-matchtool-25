# Parallel Workers vs. Gemini Studio Live — Root-Cause Analysis & Fix Plan

## 1. What Went Wrong in the Latest Log (`09-54-14.pdf`)

### Bug #1: Cross-Worker "Cookie Ping-Pong" (Why Parallel Workers Get `403 PERMISSION_DENIED` & `HTTP 500` While "Gemini Studio Live" Works)
Your observation about the cookie IDs is **100% spot-on**. Look at what happened in the PDF log between `09:45:53` and `09:46:59`:
1. **`09:45:53.851 [W01]`** loads cookies from Settings (`id=b83ed11b`).
2. **`09:45:56.842 [W01]`** opens `new_chat` and automatically saves its live cookies back to global Settings (`Saved 15 cookies from W01 -> Settings (id=6e63eb78 for all workers)`).
3. **`09:46:14.129 [W02]`** starts, loads `id=6e63eb78`, opens `new_chat`, and at **`09:46:17.112`** overwrites global Settings with `id=ba4b1612 for all workers`.
4. **`09:46:34.122 [W03]`** starts, loads `id=ba4b1612`, and at **`09:46:37.156`** overwrites global Settings with `id=99f50c1a for all workers`.
5. **`09:46:54.047 [W04]`** starts, loads `id=99f50c1a`, and at **`09:46:57.421`** overwrites global Settings with `id=8b3b1ba5 for all workers`.
6. **1 second later (`09:46:58.492`)**, `W01` clicks **Run** and immediately gets **`403 PERMISSION_DENIED`** (`09:46:59.659`)!

**Why this breaks parallel workers:**
- Google rotates `__Secure-1PSIDTS`, `__Secure-3PSIDTS`, and `SIDCC` cookies on every tab load/request.
- Because every worker (`W01`–`W04`) was overwriting the **same shared Settings cookie store** and `ensurePage()` was calling `syncContextCookiesWithSettings()` on every status/screenshot check, `W02`–`W04`'s rotated cookies were being injected straight into `W01`'s live browser mid-session.
- Even worse: when a worker restarted after an error, `ensurePage()` saw that the global Settings cookie ID (`currentFp`) no longer matched the worker's disk profile (`diskFp`), so it called `wipeProfileSessionFilesOnDisk()` — **deleting the worker's Chrome `Cookies`, `Local Storage`, and `IndexedDB` on disk**!
- **Why "Gemini Studio Live (Login Assist)" never gets this error:**
  - It runs in its own single persistent profile (`studio-chrome-profile`) without 3 other browsers overwriting its cookies every 15 seconds or wiping its `IndexedDB` / `Local Storage`.

---

### Bug #2: Opening `new_chat?model=gemini-4-argon` Instead of Clean `https://aistudio.google.com/prompts/new_chat`
- In **Gemini Studio Live (Login Assist)**, navigation always goes to clean `https://aistudio.google.com/prompts/new_chat`, which Google AI Studio converts into a real prompt session (`https://aistudio.google.com/prompts/1fOrQ...`), and the model is selected via the UI.
- In the parallel workers (`buildNewChatUrlForModel`), the code was appending `?model=gemini-4-argon` and `?model=gemini-3.8-flash` to the URL.
- `gemini-4-argon` is not a valid URL query parameter slug in AI Studio's router; when `Run` is clicked (`09:47:28` on `W02`, `09:47:58` on `W03`), the backend RPC (`GenerateContent`) fails 1.3 seconds later with `HTTP 500: [13, "Internal error encountered."]`.

---

### Bug #3: Model Switch Reversed Itself After Hard Refresh (`Argon -> 3.6 Flash -> Argon`)
Look at page 11 of the PDF log (`09:49:31` on `W02`):
- `09:49:31.520 [W02]` logged: `internal error -> switch model: switching Argon -> Gemini 3.6 Flash before hard refresh + new page`.
- `09:49:35.581 [W02]` inside `selectModelInRunSettings` logged: `Switching model to "Argon" (current="Gemini 3.6 Flash")`!
- **Why it switched back to the old model:**
  1. When `W02` switched from `Argon` to `Gemini 3.6 Flash`, it updated its lease to `Gemini 3.6 Flash` (which freed `Argon`), while `W04` was still holding `Gemini 3.6 Flash`.
  2. Inside `selectModelInRunSettings`, `orderChainByUnleasedFirst()` re-ordered the candidate list **including the first element (`targetModelName`)** so that unleased models came first. Because `Argon` was now unleased, it put `Argon` at index `0` ahead of `targetModelName` (`Gemini 3.6 Flash`) and switched `W02` right back to `Argon`!

---

### Bug #4: 4 Workers Running Simultaneously With Only 3 Models (`Argon`, `Gemini 3.8 Flash`, `Gemini 3.6 Flash`)
- Since `Gemini 3.7 Flash` is removed, there are exactly **3 allowed models**: `Argon`, `Gemini 3.8 Flash`, and `Gemini 3.6 Flash`.
- The job ran with **4 concurrent workers (`W01`–`W04`)**. When `W01`, `W02`, and `W03` took the 3 models, `W04` had no 4th model available and was forced onto `Gemini 3.8 Flash` or `Gemini 3.6 Flash` alongside another worker, violating the **1 window = 1 model** rule.

---

## 2. Implementation Plan

### Step 1: Isolate Each Worker's Cookie & Profile Session (Like "Gemini Studio Live")
- **File:** `/lib/studio-automation.ts`
- **Changes:**
  1. **Stop cross-worker global cookie overwrites:** Remove automatic calls to `saveLiveSessionToSettingsIfAuthenticated(username)` during parallel worker `new_chat` / recovery flows so `W01`–`W04` never overwrite the global Settings cookie ID (`id=...`) while workers are running.
  2. **Per-worker local session persistence:** Each worker (`studio-chrome-profile-w01`, `w02`, `w03`) keeps its own rotated cookies inside its own Chrome profile directory and its own `.worker-session-cookies.json` snapshot (each worker has its own independent cookie ID in logs, e.g. `w01-id=...`, `w02-id=...`).
  3. **Seed once, never wipe a healthy profile:** Only seed cookies from Settings (or clone from the working `studio-chrome-profile` Login Assist session) when a worker profile is first created, is logged out on `accounts.google.com`, or when the user explicitly clicks **Save Cookies** in the UI. Never call `wipeProfileSessionFilesOnDisk` or inject another worker's cookies into a running worker browser.

### Step 2: Always Open Clean `https://aistudio.google.com/prompts/new_chat`
- **File:** `/lib/studio-automation.ts`
- **Changes:**
  1. Update `buildNewChatUrlForModel()` to always return clean `https://aistudio.google.com/prompts/new_chat` (without `?model=...` URL query parameters), matching **Gemini Studio Live (Login Assist)** behavior.
  2. Model selection happens strictly through the Run Settings UI panel (`selectModelInRunSettings`) after the clean `new_chat` page loads.

### Step 3: Fix `selectModelInRunSettings` Model Reversal & Output Tokens (`1,000,000` for Argon)
- **File:** `/lib/studio-automation.ts`
- **Changes:**
  1. In `selectModelInRunSettings(page, targetModelName, ...)`: Always keep `targetModelName` at **index 0** of `candidatesToTry`. Only apply `orderChainByUnleasedFirst` to the **fallback** candidates (`baseCandidates.slice(1)`), so when a worker switches `Argon -> Gemini 3.6 Flash`, `selectModelInRunSettings` never reverses it back to `Argon`.
  2. Ensure `updateExclusiveStudioModelLease(this.profileDirName, activeModelName)` is called immediately when a worker switches models and when `selectModelInRunSettings` locks onto a model.
  3. Keep the `Output length = 1000000` setting whenever `Argon` is active (which worked in the log at `09:46:38.057: outputTokens=1000000`).

### Step 4: Enforce Strict 1-Window = 1-Model Concurrency (Max 3 Active Model Windows)
- **Files:** `/lib/studio-model-state.ts`, `/lib/studio-automation.ts`, `/components/cmt/studio-parallel-grid.tsx`
- **Changes:**
  1. Because only **3 models** exist (`Argon`, `Gemini 3.8 Flash`, `Gemini 3.6 Flash`) and **1 window = 1 model** is required, cap parallel worker concurrency to **3 active model leases** (and default/max parallel windows to 3 for single-account runs, or make a 4th worker wait in queue until one of the 3 models is released).
  2. Ensure `acquireExclusiveStudioModelLease` strictly assigns an unleased model from `['Argon', 'Gemini 3.8 Flash', 'Gemini 3.6 Flash']` so no two active windows ever share the same model at the same time.
