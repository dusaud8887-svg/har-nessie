const SUPPORTED_FOLDER_PICKER_PLATFORMS = new Set(['win32', 'darwin', 'linux']);

export function isFolderPickerSupportedPlatform(platform = process.platform) {
  return SUPPORTED_FOLDER_PICKER_PLATFORMS.has(String(platform || '').trim());
}

export function folderPickerUnsupportedMessage(platform = process.platform) {
  const value = String(platform || '').trim() || 'unknown';
  return `Folder picker dialog is not available on ${value}. Enter the project path manually.`;
}

export function folderPickerUnavailableMessage(platform = process.platform) {
  const value = String(platform || '').trim() || 'unknown';
  if (value === 'linux') {
    return 'No supported Linux folder picker was found. Install zenity, qarma, or kdialog, or enter the project path manually.';
  }
  if (value === 'darwin') {
    return 'macOS folder picker is unavailable. Check that osascript is installed, or enter the project path manually.';
  }
  return `Folder picker dialog could not be launched on ${value}. Enter the project path manually.`;
}

export function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function normalizeUiLanguage(value) {
  return String(value || '').trim().toLowerCase() === 'en' ? 'en' : 'ko';
}

function folderDialogCopy(uiLanguage = 'en') {
  const language = normalizeUiLanguage(uiLanguage);
  return {
    dialogTitle: language === 'en' ? 'Choose a project folder' : '프로젝트 폴더를 선택하세요',
    fileName: language === 'en' ? 'Choose folder' : '폴더 선택'
  };
}

export function buildPickFolderDialogScript(initialPath = '', uiLanguage = 'en') {
  const { dialogTitle, fileName } = folderDialogCopy(uiLanguage);
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    `$initialPath = '${escapePowerShellSingleQuoted(initialPath)}'`,
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Title = '${escapePowerShellSingleQuoted(dialogTitle)}'`,
    "$dialog.CheckFileExists = $false",
    "$dialog.CheckPathExists = $true",
    "$dialog.ValidateNames = $false",
    `$dialog.FileName = '${escapePowerShellSingleQuoted(fileName)}'`,
    "if ($initialPath -and (Test-Path -LiteralPath $initialPath -PathType Container)) { $dialog.InitialDirectory = $initialPath }",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [System.IO.Path]::GetDirectoryName($dialog.FileName) }"
  ].join('; ');
}

export function buildMacOsPickFolderDialogScript() {
  return [
    'set dialogTitle to system attribute "HARNESS_PICK_FOLDER_TITLE"',
    'set initialPath to system attribute "HARNESS_PICK_FOLDER_INITIAL_PATH"',
    'if initialPath is not "" then',
    '  set chosenFolder to choose folder with prompt dialogTitle default location (POSIX file initialPath)',
    'else',
    '  set chosenFolder to choose folder with prompt dialogTitle',
    'end if',
    'POSIX path of chosenFolder'
  ];
}

function ensureLinuxDialogPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return /[\\/]$/.test(normalized) ? normalized : `${normalized}/`;
}

export function buildLinuxPickFolderLaunchers(initialPath = '', uiLanguage = 'en') {
  const { dialogTitle } = folderDialogCopy(uiLanguage);
  const filename = ensureLinuxDialogPath(initialPath);
  return [
    {
      command: 'zenity',
      args: [
        '--file-selection',
        '--directory',
        '--title',
        dialogTitle,
        ...(filename ? ['--filename', filename] : [])
      ]
    },
    {
      command: 'qarma',
      args: [
        '--file-selection',
        '--directory',
        '--title',
        dialogTitle,
        ...(filename ? ['--filename', filename] : [])
      ]
    },
    {
      command: 'kdialog',
      args: [
        '--getexistingdirectory',
        filename || '.',
        '--title',
        dialogTitle
      ]
    }
  ];
}
