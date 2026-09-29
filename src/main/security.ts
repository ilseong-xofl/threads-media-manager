function localFilePath(value: string): string | null {
  // Reject traversal before URL parsing can normalize dot segments away. Encoded
  // separators cannot be file names and must not change the directory boundary.
  if (/(?:^|[\\/])(?:\.|%2e){1,2}(?=[\\/?#]|$)/i.test(value) || /%(?:2f|5c|00)/i.test(value))
    return null;
  const url = new URL(value);
  if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return null;
  return decodeURIComponent(url.pathname);
}

export function isLocalRequest(url: string, entry: string): boolean {
  try {
    const target = new URL(url);
    const page = new URL(entry);
    if (target.protocol === 'threads-media:')
      return /^threads-media:\/\/(?:file\/[a-f0-9]{32}|ai\/[a-f0-9]{32}\/[12])$/.test(url);
    if (page.protocol === 'file:') {
      const targetPath = localFilePath(url);
      const entryPath = localFilePath(entry);
      if (targetPath === null || entryPath === null) return false;
      const rendererDirectory = entryPath.slice(0, entryPath.lastIndexOf('/') + 1);
      return targetPath.startsWith(rendererDirectory);
    }
    // Forge serves scripts and its HMR socket on the same dedicated loopback port.
    return (
      page.protocol === 'http:' &&
      ['http:', 'ws:'].includes(target.protocol) &&
      ['localhost', '127.0.0.1'].includes(target.hostname) &&
      target.hostname === page.hostname &&
      target.port === page.port
    );
  } catch {
    return false;
  }
}
export function isTrustedFrame(
  senderId: number,
  windowId: number,
  isMainFrame: boolean,
  url: string,
  entry: string,
): boolean {
  if (senderId !== windowId || !isMainFrame) return false;
  try {
    return new URL(url).href === new URL(entry).href;
  } catch {
    return false;
  }
}
