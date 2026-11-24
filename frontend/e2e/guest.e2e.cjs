// Guest journey: join by email link, participate, restrictions, upgrade keeps data.
const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }); ctx.setDefaultTimeout(4000); const g2 = await ctx.newPage();
  g2.on('pageerror', (e) => console.log('PAGEERR', e.message));
  const s = async (n, f) => { try { await f(); console.log('ok', n); } catch (e) { console.log('FAIL', n, e.message.split('\n')[0]); await g2.screenshot({ path: '/tmp/claude-0/shots/gfail.png' }); throw e; } };
  await g2.goto(BASE + '/join/guest-demo'); await g2.getByLabel('Your name').fill('Gus'); await g2.getByRole('button', { name: 'Join group' }).click();
  await s('joined', () => g2.getByRole('log').getByText(/Gus joined/).waitFor());
  await s('no create', async () => { if (await g2.getByRole('button', { name: 'Create' }).count()) throw new Error('create visible'); });
  await s('pinned', () => g2.getByTestId('pinned').getByText('Sunday ridge hike').waitFor());
  await s('join', async () => { await g2.getByTestId('pinned').getByRole('button', { name: /Join Sunday ridge hike/ }).click(); await g2.getByTestId('pinned').getByRole('button', { name: /You're going/ }).waitFor(); });
  await s('details', async () => { await g2.getByTestId('event-message').getByText('Details').click(); await g2.getByRole('heading', { name: /Who's going/ }).waitFor(); });
  await s('claim', async () => { const t = g2.getByTestId('task').filter({ hasText: 'First-aid kit' }); await t.getByRole('button', { name: 'Claim' }).click(); await t.getByRole('button', { name: 'Release' }).waitFor(); });
  await s('members', async () => { await g2.getByRole('button', { name: 'Back' }).click(); await g2.getByRole('button', { name: 'Group info' }).click(); await g2.getByTestId('member').first().waitFor(); if (await g2.getByText(/@example\.com/).count()) throw new Error('email leaked'); });
  await s('blocked create', async () => { await g2.goto(BASE+'/events/new'); await g2.getByText('Registered accounts only').waitFor(); });
  await s('upgrade', async () => { await g2.goto(BASE+'/me'); await g2.getByLabel('Email').fill('gus@example.com'); await g2.getByLabel('Choose a password').fill('supersecret'); await g2.getByRole('button', { name: 'Create account' }).click(); await g2.getByText('Member', { exact: true }).waitFor(); });
  await s('data kept', async () => { await g2.getByRole('link', { name: 'Chats' }).click(); await g2.getByRole('link', { name: /Weekend hikers/ }).waitFor(); await g2.getByRole('button', { name: 'Create' }).waitFor(); await g2.goto(BASE+'/tasks'); await g2.getByText('First-aid kit').waitFor(); });
  await b.close();
})().catch(() => process.exit(1));
