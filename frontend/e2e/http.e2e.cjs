// Integration against the REAL backend (VITE_API_MODE=http, backend on :4000 via the dev proxy).
// Run: BASE=http://127.0.0.1:5174 MAILLOG=/path/to/backend.log node e2e/http.e2e.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const MAILLOG = process.env.MAILLOG;
let failed = 0;
const step = async (n, f) => { try { await f(); console.log('  ✓', n); } catch (e) { failed++; console.log('  ✗', n, '\n    ', String(e.message).split('\n')[0]); } };
(async () => {
  const startLen = fs.statSync(MAILLOG).size;   // only read mail logged during this run
  const b = await chromium.launch(); const errors = [];
  const mk = async (vp) => { const c = await b.newContext({ viewport: vp, isMobile: vp.width < 600 }); c.setDefaultTimeout(8000); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };
  const host = await mk({ width: 390, height: 844 }); const email = `host${Date.now()}@test.dev`;
  await step('sign up', async () => {
    await host.goto(BASE + '/signup'); await host.getByLabel('Your name').fill('Hana Host'); await host.getByLabel('Email').fill(email); await host.getByLabel('Password').fill('correct horse');
    await host.getByRole('button', { name: 'Sign up' }).click(); await host.getByRole('heading', { name: 'Upcoming events' }).waitFor();
  });
  await step('create group and invite a guest by email', async () => {
    await host.goto(BASE + '/groups/new'); await host.getByLabel('Group name').fill('Real Group');
    await host.getByLabel(/Invite people by email/).fill(`g1${Date.now()}@test.dev, g2${Date.now()}@test.dev`); await host.getByLabel(/Invite people by email/).press('Enter');
    await host.getByRole('button', { name: /Create group & invite 2/ }).click(); await host.getByText('This is the start of the conversation').waitFor();
  });
  await step('create event (tasks, min/max) → event message + pinned', async () => {
    await host.getByRole('link', { name: 'New event in this group' }).click();
    await host.getByLabel('Event name').fill('Real BBQ'); await host.getByRole('button', { name: '+ Snacks' }).click(); await host.getByRole('button', { name: '+ Drinks' }).click();
    await host.getByRole('button', { name: 'Create event' }).click(); await host.getByRole('heading', { name: /Who's going/ }).waitFor();
    await host.getByRole('button', { name: 'Back' }).click(); // back to chat? (replace nav) -> go via list
  });
  await step('event is pinned + interactive message in chat', async () => {
    await host.goto(BASE + '/'); await host.getByRole('link', { name: /Real Group/ }).click();
    await host.getByTestId('pinned').getByText('Real BBQ').waitFor(); await host.getByTestId('event-message').getByText('Real BBQ').waitFor();
  });
  let token;
  await step('invitation email delivered with join link', async () => {
    const log = fs.readFileSync(MAILLOG, 'utf8').slice(startLen); const all = [...log.matchAll(/invite\?token=([\w-]+)/g)]; token = all[0][1]; if (!token) throw new Error('no token');
  });
  const guest = await mk({ width: 390, height: 844 });
  await step('guest joins via link without registering', async () => {
    await guest.goto(BASE + '/invite?token=' + token); await guest.getByRole('heading', { name: 'Real Group' }).waitFor();
    await guest.getByLabel('Your name').fill('Gigi Guest'); await guest.getByRole('button', { name: 'Join group' }).click();
    await guest.getByRole('log').getByText(/Gigi Guest joined/).waitFor(); await guest.getByTestId('pinned').getByText('Real BBQ').waitFor();
    if (await guest.getByRole('button', { name: 'Create' }).count()) throw new Error('guest sees create');
  });
  await step('realtime: host message appears for guest without reload', async () => {
    await host.getByLabel('Message', { exact: true }).fill('hello guest'); await host.getByRole('button', { name: 'Send' }).click();
    await guest.getByRole('log').getByText('hello guest').waitFor();
    await guest.getByLabel('Message', { exact: true }).fill('hi host'); await guest.getByRole('button', { name: 'Send' }).click();
    await host.getByRole('log').getByText('hi host').waitFor();
  });
  await step('guest joins event + claims task; host sees counts update live', async () => {
    await guest.getByTestId('pinned').getByRole('button', { name: /Join Real BBQ/ }).click();
    await host.getByTestId('event-message').getByText(/2 people going/).waitFor();
    await guest.getByTestId('event-message').getByText('Details').click();
    const t = guest.getByTestId('task').filter({ hasText: 'Snacks' }); await t.getByRole('button', { name: 'Claim' }).click(); await t.getByRole('button', { name: 'Release' }).waitFor();
    await t.getByRole('checkbox').check(); await t.getByText(/done/).waitFor(); if (!(await t.getByRole('checkbox').isDisabled())) throw new Error('completed task should be final');
  });
  await step('guest upgrade keeps memberships and tasks', async () => {
    await guest.goto(BASE + '/me'); await guest.getByLabel('Choose a password').fill('another secret');
    await guest.getByRole('button', { name: 'Create account' }).click(); await guest.getByText('Member', { exact: true }).waitFor();
    await guest.goto(BASE + '/'); await guest.getByRole('link', { name: /Real Group/ }).waitFor(); await guest.getByRole('button', { name: 'Create' }).waitFor();
  });
  await step('unread badge shows for new message', async () => {
    await host.goto(BASE + '/'); await guest.goto(BASE + '/');
    await host.getByRole('link', { name: /Real Group/ }).waitFor();
    await guest.getByRole('link', { name: /Real Group/ }).click(); await guest.getByLabel('Message', { exact: true }).fill('ping'); await guest.getByRole('button', { name: 'Send' }).click();
    await host.getByRole('link', { name: /Real Group, 1 unread/ }).waitFor();
  });
  await step('cancel event → cancelled state for everyone', async () => {
    await host.goto(BASE + '/'); await host.getByRole('link', { name: 'Open Real BBQ' }).first().click(); await host.getByRole('button', { name: 'Cancel event' }).click();
    await host.getByRole('button', { name: 'Cancel event' }).last().click(); await host.getByText('This event has been cancelled.').waitFor();
  });
  await step('error state: bad invite link', async () => { await guest.goto(BASE + '/invite?token=not-a-real-token-0000000000'); await guest.getByText(/invalid or has expired|not valid/).waitFor(); });
  console.log(errors.length ? 'page errors: ' + [...new Set(errors)].join('; ') : 'No page errors');
  await b.close(); process.exit(failed || errors.length ? 1 : 0);
})();
