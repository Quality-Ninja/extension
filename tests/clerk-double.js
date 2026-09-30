// Copied over dist/auth.js only in a temporary unpacked extension by Playwright.
// The production build never imports this file or exposes a test authentication switch.
const NinjaClerk = {
  async getSession(config, fresh) {
    const session = await NinjaStore.get('settings', 'test_clerk');
    if (session?.error) throw Object.assign(new Error('Clerk is offline.'), { status: 503 });
    if (!session) return null;
    if (fresh && session.refreshToken) return { ...session, token: session.refreshToken };
    return session;
  },
  async signOut() { await NinjaStore.put('settings', null, 'test_clerk'); }
};
