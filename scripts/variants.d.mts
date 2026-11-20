export interface Variant {
  name: string;
  /** Shown inside the app: window title, sign-in brand, header and footer. */
  displayName: string;
  /** Start menu shortcut and installed-programs name; also the executable's ProductName. */
  productName: string;
  /** Start menu folder and publisher; also the executable's CompanyName. */
  companyName: string;
  /** Icon file name in `assets` without its extension (`.ico` and `.png`). */
  icon: string;
  /** Company and product names of earlier releases, whose shortcuts an update removes. */
  formerShortcuts: { companyName: string; productName: string }[];
  /** Electron app name (`app.setName`). The macOS keychain entry of safeStorage is named by it. */
  appName: string;
  /** Packager name: the `out/<packageName>-win32-x64` folder. */
  packageName: string;
  executableName: string;
  /** Squirrel package ID: the install folder and the update package name. */
  squirrelName: string;
  setupExe: string;
  appUserModelId: string;
  /** Folder under %APPDATA%. */
  userDataDir: string;
  serviceUrl: string;
  updateRepository: string;
}
export interface BundleValues {
  displayName: string;
  appName: string;
  icon: string;
  formerShortcuts: { companyName: string; productName: string }[];
  appUserModelId: string;
  userDataDir: string;
  serviceUrl: string;
  updateRepository: string;
}
export const variantNames: string[];
export function selectVariant(name: string | undefined): Variant;
export function otherVariants(name: string): Variant[];
export function bundleValues(
  packaged: boolean,
  env: Record<string, string | undefined>,
): BundleValues;
