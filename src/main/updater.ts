import { app, dialog, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

// electron-updater ships as CommonJS; destructure the default export for ESM interop.
const { autoUpdater } = electronUpdater

/** Show a native message box, anchored to the window when we have one. */
function ask(win: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number> {
  const result = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  return result.then((r) => r.response)
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
        const wantsDownload = await ask(win, {
          type: 'info',
          buttons: ['Download && install', 'Not now'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update available',
          message: `Expense Tracker v${info.version} is available.`,
          detail: `You have v${version}. Download the update now?`
        })
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
