export interface Variant {
  name: string;
  /** Shown inside the app: window title, sign-in brand, header and footer. */
  displayName: string;
  /** Start menu and installed-programs name; also the executable's ProductName. */
  productName: string;
  companyName: string;
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
