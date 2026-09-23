export function isLocalRequest(url: string, entry: string): boolean {
  try {
    const target = new URL(url);
    const page = new URL(entry);
    if (target.protocol === 'threads-media:')
      return /^threads-media:\/\/(?:file\/[a-f0-9]{32}|ai\/[a-f0-9]{32}\/[12])$/.test(url);
    // Forge serves scripts and its HMR socket on the same dedicated loopback port.
    return (
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
  return senderId === windowId && isMainFrame && url === entry;
}
