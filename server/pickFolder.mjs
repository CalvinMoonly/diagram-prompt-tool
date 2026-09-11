import { execFile } from 'node:child_process'

// A browser cannot hand us a filesystem path - showDirectoryPicker and
// webkitdirectory both withhold it on purpose. The server can, because it runs
// on the same machine, so the OS folder dialog opens from here instead.
//
// The dialog appears on whoever is running the server. That is the same person
// looking at the page, which is the only way this tool is meant to be used.

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
# An invisible topmost form as owner, or the dialog can open behind the browser.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Pick a repo for PromptCanvas'
$dlg.ShowNewFolderButton = $false
if ($env:PC_START -and (Test-Path -LiteralPath $env:PC_START)) { $dlg.SelectedPath = $env:PC_START }
$result = $dlg.ShowDialog($owner)
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }
`.trim()

const MAC_SCRIPT = 'try\nPOSIX path of (choose folder with prompt "Pick a repo for PromptCanvas")\nend try'

function runner (startIn) {
  const env = { ...process.env, PC_START: startIn ?? '' }
  if (process.platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT], env]
  }
  if (process.platform === 'darwin') {
    return ['osascript', ['-e', MAC_SCRIPT], env]
  }
  // zenity is the common one on Linux desktops; absence is reported, not fatal.
  return ['zenity', ['--file-selection', '--directory', '--title=Pick a repo for PromptCanvas'], env]
}

// Only one dialog at a time, or a stray double-click leaves orphans behind.
let open = false

export function pickFolder (startIn) {
  if (open) return Promise.resolve({ supported: true, busy: true, dir: null })
  const [cmd, args, env] = runner(startIn)
  open = true

  return new Promise(resolve => {
    execFile(cmd, args, { env, timeout: 5 * 60_000, windowsHide: true }, (err, stdout) => {
      open = false
      const dir = String(stdout ?? '').trim()
      if (dir) return resolve({ supported: true, dir })
      // zenity/osascript exit non-zero on cancel; a missing binary is ENOENT.
      if (err?.code === 'ENOENT') {
        return resolve({ supported: false, dir: null, reason: `no folder dialog available (${cmd} not found)` })
      }
      resolve({ supported: true, dir: null })
    })
  })
}
