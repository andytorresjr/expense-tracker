import { app, dialog, shell, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

// electron-updater ships as CommonJS; destructure the default export for ESM interop.
const { autoUpdater } = electronUpdater

const REPO = 'andytorresjr/expense-tracker'
const releasePageUrl = (version: string): string => `https://github.com/${REPO}/releases/tag/v${version}`

/** Show a native message box, anchored to the window when we have one. */
function ask(win: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number> {
  const result = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  return result.then((r) => r.response)
}

/** Pull the release notes (markdown body + page URL) for a version off the public GitHub API. */
async function fetchReleaseNotes(version: string): Promise<{ body: string; url: string }> {
  const url = releasePageUrl(version)
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
      headers: { 'User-Agent': 'Expense-Tracker-Updater', Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) return { body: '', url }
    const data = (await res.json()) as { body?: string; html_url?: string }
    return { body: (data.body ?? '').trim(), url: data.html_url || url }
  } catch {
    return { body: '', url }
  }
}

/** Lightly strip markdown so release notes read cleanly inside a native dialog. */
function mdToPlain(md: string, max = 1200): string {
  const plain = md
    .replace(/`{1,3}/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .trim()
  return plain.length > max ? `${plain.slice(0, max).trimEnd()}\n…` : plain
}

let inProgress = false

/**
 * Manual, user-initiated update check (wired to the Settings button). The app is
 * offline by default — this is the only code that reaches the network, and only
 * when the user clicks. Flow: check GitHub releases → if newer, ask to download →
 * download → ask to restart and install. Auto-download is off so nothing happens
 * without consent.
 */
export async function checkForUpdates(win: BrowserWindow | null): Promise<UpdateStatus> {
  const version = app.getVersion()

  if (!app.isPackaged) {
    return {
      state: 'unsupported',
      version,
      message: 'Update checks only work in the installed app, not in development.'
    }
  }
  if (inProgress) {
    return { state: 'unsupported', version, message: 'An update check is already running.' }
  }

  inProgress = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // We ship pre-release ("-beta") versions during the beta, so the updater must
  // accept them. Stable releases are always offered too, so this still picks up
  // the eventual production build.
  autoUpdater.allowPrerelease = true
  autoUpdater.removeAllListeners()

  try {
    return await new Promise<UpdateStatus>((resolve) => {
      const finish = (status: UpdateStatus): void => {
        autoUpdater.removeAllListeners()
        resolve(status)
      }

      autoUpdater.on('error', (err: Error) => {
        finish({ state: 'error', version, message: `Update check failed: ${err?.message ?? String(err)}` })
      })

      autoUpdater.on('update-not-available', () => {
        finish({ state: 'up-to-date', version, message: `You're up to date — v${version} is the latest.` })
      })

      autoUpdater.on('update-available', async (info: { version: string }) => {
        const notes = await fetchReleaseNotes(info.version)
        const whatsNew = notes.body ? `\n\nWhat's new:\n${mdToPlain(notes.body)}` : ''

        // Loop so "View full notes online" can open GitHub and return to the prompt.
        let wantsDownload = 1
        for (;;) {
          const choice = await ask(win, {
            type: 'info',
            buttons: ['Download && install', 'View full notes online', 'Not now'],
            defaultId: 0,
            cancelId: 2,
            title: `Update available — v${info.version}`,
            message: `Expense Tracker v${info.version} is available (you have v${version}).${whatsNew}`,
            detail: 'Download and install the update now?'
          })
          if (choice === 1) {
            await shell.openExternal(notes.url)
            continue
          }
          wantsDownload = choice === 0 ? 0 : 1
          break
        }
        if (wantsDownload !== 0) {
          finish({ state: 'declined', version, latestVersion: info.version, message: `Update to v${info.version} postponed.` })
          return
        }

        autoUpdater.on('update-downloaded', async () => {
          const wantsRestart = await ask(win, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update ready',
            message: `v${info.version} downloaded.`,
            detail: 'Restart now to install? Otherwise it installs automatically the next time you quit.'
          })
          if (wantsRestart === 0) {
            autoUpdater.removeAllListeners()
            resolve({ state: 'downloaded', version, latestVersion: info.version, message: 'Restarting to install…' })
            setImmediate(() => autoUpdater.quitAndInstall())
          } else {
            finish({
              state: 'downloaded',
              version,
              latestVersion: info.version,
              message: `v${info.version} will install when you quit the app.`
            })
          }
        })

        autoUpdater.downloadUpdate().catch((err: Error) => {
          finish({ state: 'error', version, message: `Download failed: ${err?.message ?? String(err)}` })
        })
      })

      autoUpdater.checkForUpdates().catch((err: Error) => {
        finish({ state: 'error', version, message: `Update check failed: ${err?.message ?? String(err)}` })
      })
    })
  } finally {
    inProgress = false
  }
}
