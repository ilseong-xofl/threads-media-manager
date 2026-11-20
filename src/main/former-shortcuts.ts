import { rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** The executable's CompanyName and ProductName in a release that was installed before. */
export interface FormerShortcut {
  companyName: string;
  productName: string;
}

/**
 * Squirrel.Windows names its two default shortcuts from the executable's version information:
 * `Desktop\<ProductName>.lnk` and `Start Menu\Programs\<CompanyName>\<ProductName>.lnk`.
 */
export function formerShortcutPaths(former: FormerShortcut, desktop: string, appData: string) {
  const startMenuFolder = join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    former.companyName,
  );
  const file = `${former.productName}.lnk`;
  return {
    desktop: join(desktop, file),
    startMenu: join(startMenuFolder, file),
    startMenuFolder,
  };
}

/**
 * Squirrel starts the new version with `--squirrel-install` or `--squirrel-updated` and creates
 * shortcuts under its current names. Shortcuts made under a former name stay behind, so they are
 * removed here. Pinned taskbar items are not touched. A failure never stops the install or update.
 */
export function removeFormerShortcuts(
  command: string | undefined,
  former: FormerShortcut[],
  getPath: (name: 'desktop' | 'appData') => string,
): void {
  if (command !== '--squirrel-install' && command !== '--squirrel-updated') return;
  const attempt = (action: () => void) => {
    try {
      action();
    } catch {
      // Already gone, in use or not removable: a leftover shortcut is harmless.
    }
  };
  attempt(() => {
    for (const names of former) {
      const paths = formerShortcutPaths(names, getPath('desktop'), getPath('appData'));
      attempt(() => unlinkSync(paths.desktop));
      attempt(() => unlinkSync(paths.startMenu));
      // Fails, and so keeps the folder, while anything is left in it.
      attempt(() => rmdirSync(paths.startMenuFolder));
    }
  });
}
