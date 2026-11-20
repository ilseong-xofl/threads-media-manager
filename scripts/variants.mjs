// The one reader of variants.json for Forge, webpack, the verification scripts and tests.
// App code never imports this: a bundle must hold only the values of its own variant.
import { readFileSync } from 'node:fs';

const variants = JSON.parse(readFileSync(new URL('../variants.json', import.meta.url), 'utf8'));

export const variantNames = Object.keys(variants);

/** Throws for a missing or unknown name, so a packaged build never falls back to a variant. */
export function selectVariant(name) {
  if (typeof name !== 'string' || !Object.hasOwn(variants, name))
    throw new Error(
      `Set TMM_VARIANT to one of: ${variantNames.join(', ')}. Got ${JSON.stringify(name ?? null)}.`,
    );
  return { name, ...variants[name] };
}

export const otherVariants = (name) =>
  variantNames.filter((other) => other !== name).map(selectVariant);

/**
 * Values compiled into the app. A packaged build takes everything from its variant. An unpackaged
 * run (`pnpm start`) keeps its local service default and has no updates; it only shows the dev name
 * and icon.
 */
export function bundleValues(packaged, env) {
  const variant = selectVariant(packaged ? env.TMM_VARIANT : 'dev');
  return {
    displayName: variant.displayName,
    appName: variant.appName,
    icon: variant.icon,
    formerShortcuts: variant.formerShortcuts,
    appUserModelId: variant.appUserModelId,
    userDataDir: variant.userDataDir,
    serviceUrl: packaged ? variant.serviceUrl : (env.THREADS_ADMIN_API_URL ?? ''),
    updateRepository: packaged ? variant.updateRepository : '',
  };
}
