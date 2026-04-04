import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLinuxPickFolderLaunchers,
  buildMacOsPickFolderDialogScript,
  buildPickFolderDialogScript,
  folderPickerUnavailableMessage,
  isFolderPickerSupportedPlatform
} from '../app/folder-picker.mjs';

test('folder picker script uses .NET path extraction instead of Split-Path', () => {
  const script = buildPickFolderDialogScript("D:/repo's");

  assert.match(script, /\[System\.IO\.Path\]::GetDirectoryName\(\$dialog\.FileName\)/);
  assert.doesNotMatch(script, /Split-Path -LiteralPath \$dialog\.FileName -Parent/);
  assert.match(script, /\$initialPath = 'D:\/repo''s'/);
});

test('folder picker support includes Windows, macOS, and Linux', () => {
  assert.equal(isFolderPickerSupportedPlatform('win32'), true);
  assert.equal(isFolderPickerSupportedPlatform('darwin'), true);
  assert.equal(isFolderPickerSupportedPlatform('linux'), true);
  assert.equal(isFolderPickerSupportedPlatform('freebsd'), false);
});

test('macOS picker script reads prompt and initial path from environment', () => {
  const script = buildMacOsPickFolderDialogScript().join('\n');

  assert.match(script, /system attribute "HARNESS_PICK_FOLDER_TITLE"/);
  assert.match(script, /system attribute "HARNESS_PICK_FOLDER_INITIAL_PATH"/);
  assert.match(script, /choose folder with prompt dialogTitle/);
});

test('linux picker launchers include common desktop dialogs and normalize initial path', () => {
  const launchers = buildLinuxPickFolderLaunchers('/repo/path', 'en');

  assert.deepEqual(launchers[0], {
    command: 'zenity',
    args: ['--file-selection', '--directory', '--title', 'Choose a project folder', '--filename', '/repo/path/']
  });
  assert.deepEqual(launchers[1], {
    command: 'qarma',
    args: ['--file-selection', '--directory', '--title', 'Choose a project folder', '--filename', '/repo/path/']
  });
  assert.deepEqual(launchers[2], {
    command: 'kdialog',
    args: ['--getexistingdirectory', '/repo/path/', '--title', 'Choose a project folder']
  });
  assert.match(folderPickerUnavailableMessage('linux'), /zenity, qarma, or kdialog/i);
});
