// End-to-end checks against the mock API. Run: node e2e/mock.e2e.cjs  (dev server on :5173)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:5173';
const SHOTS = process.env.SHOTS || '/tmp/claude-0/shots';
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n    ', String(e.message).split('\n')[0]); } };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (opts) => {
    const ctx = await browser.newContext({ deviceScaleFactor: 1, ...opts });
    ctx.setDefaultTimeout(6000);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
    return page;
  };

  console.log('Registered user · mobile');
  const m = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.goto(BASE + '/');
  await step('redirects to login when signed out', async () => { await m.waitForURL(/\/login/); });
  await step('login validation + error state', async () => {
    await m.getByRole('button', { name: 'Sign in' }).click();
    await m.getByText('Enter a valid email address').waitFor();
    await m.getByLabel('Email').fill('alice@example.com'); await m.getByLabel('Password').fill('wrong-pass');
    await m.getByRole('button', { name: 'Sign in' }).click(); await m.getByText('Incorrect email or password').waitFor();
  });
  await step('sign in with demo account', async () => {
    await m.getByRole('button', { name: 'Fill demo login' }).click(); await m.getByRole('button', { name: 'Sign in' }).click();
    await m.getByRole('heading', { name: 'Upcoming events' }).waitFor();
  });
  await step('home: events, tasks, groups with unread', async () => {
    await m.getByText('Bouldering night').first().waitFor();
    await m.getByRole('heading', { name: /Your tasks/ }).waitFor();
    await m.getByRole('link', { name: /Climbing crew, 2 unread/ }).waitFor();
    await m.getByRole('button', { name: 'Create' }).waitFor();
  });
  await m.screenshot({ path: `${SHOTS}/m-home.png` });
  await step('chat: open group, messages, event message, pinned strip', async () => {
    await m.getByRole('link', { name: /Climbing crew/ }).click();
    await m.getByRole('log').getByText("I'll bring the chalk").waitFor();
    await m.getByTestId('event-message').waitFor();
    await m.getByTestId('pinned').getByText('Bouldering night').waitFor();
  });
  await m.waitForTimeout(400); await m.screenshot({ path: `${SHOTS}/m-chat.png` });
  await step('join from pinned card (one tap) updates event message live', async () => {
    const before = await m.getByTestId('event-message').innerText();
    assert.match(before, /2 people going/);
    await m.getByTestId('pinned').getByRole('button', { name: /Join Bouldering night/ }).click();
    await m.getByTestId('event-message').getByText(/3 people going/).waitFor();
    await m.getByTestId('event-message').getByRole('button', { name: /You're going/ }).waitFor();
  });
  await step('send message and get a reply (realtime)', async () => {
    await m.getByLabel('Message', { exact: true }).fill('See you there!'); await m.getByRole('button', { name: 'Send' }).click();
    await m.getByRole('log').getByText('See you there!').waitFor();
    await m.getByRole('log').getByText(/Sounds good|Count me in|Nice one/).waitFor({ timeout: 6000 });
  });
  await step('unread cleared after reading', async () => {
    await m.goBack(); await m.getByRole('link', { name: /^Climbing crew(?!, \d+ unread)/ }).waitFor();
  });
  await step('event page: details, status, claim, tick', async () => {
    await m.getByRole('link', { name: 'Open Bouldering night' }).first().click();
    await m.getByRole('heading', { name: /Who's going/ }).waitFor();
    await m.getByTestId('min-status').getByText(/Needs 1 more person/).waitFor();
    await m.getByTestId('task-status').getByText(/tasks? still need someone/).waitFor();
    await m.getByRole('region', { name: /Event location/ }).waitFor();
    const snacks = m.getByTestId('task').filter({ hasText: 'Snacks' });
    await snacks.getByRole('button', { name: 'Claim' }).click();
    await snacks.getByRole('button', { name: 'Release' }).waitFor();
    await snacks.getByRole('checkbox').check(); await snacks.getByText(/done/).waitFor();
  });
  await m.screenshot({ path: `${SHOTS}/m-event.png`, fullPage: false });
  await step('tasks page shows my tasks grouped with deadline', async () => {
    await m.goto(BASE + '/tasks'); await m.getByText('Bring chalk').first().waitFor().catch(() => {});
  });
  await step('create event: validation, multi-group, tasks', async () => {
    await m.goto(BASE + '/'); await m.getByRole('button', { name: 'Create' }).click(); await m.getByText('New event').click();
    await m.getByRole('button', { name: 'Create event' }).click();
    await m.getByText('Give your event a name').waitFor(); await m.getByText('Choose at least one group to send it to').waitFor();
    await m.getByLabel('Event name').fill('Board game night');
    await m.getByLabel('Where?').fill('Park'); await m.getByRole('option', { name: /Victoria Park/ }).click();
    await m.getByRole('button', { name: '+ Snacks' }).click(); await m.getByRole('button', { name: '+ Games' }).click();
    await m.getByRole('button', { name: 'Increase minimum' }).click();
    await m.getByRole('switch', { name: 'Set a maximum' }).check();
    await m.getByRole('button', { name: 'Climbing crew' }).click(); await m.getByRole('button', { name: 'Book club' }).click();
    await m.screenshot({ path: `${SHOTS}/m-event-new.png`, fullPage: true });
    await m.getByRole('button', { name: 'Create event' }).click();
    await m.getByRole('heading', { name: /Who's going/ }).waitFor();
    await m.getByText('Snacks').waitFor(); await m.getByText('Games').waitFor();
  });
  await step('new event appears in both groups as a message + pinned', async () => {
    for (const g of ['Climbing crew', 'Book club']) {
      await m.goto(BASE + '/'); await m.getByRole('link', { name: new RegExp(g) }).click();
      await m.getByTestId('pinned').getByText('Board game night').waitFor();
      await m.getByTestId('event-message').filter({ hasText: 'Board game night' }).waitFor();
    }
  });
  await step('group creation with multiple emails + location', async () => {
    await m.goto(BASE + '/groups/new');
    await m.getByLabel('Group name').fill('Hike gang');
    await m.getByLabel('Where is the group based?').fill('Heath'); await m.getByRole('option', { name: /Hampstead Heath/ }).click();
    await m.getByLabel(/Invite people by email/).fill('a@x.io, b@x.io not-an-email');
    await m.getByLabel(/Invite people by email/).press('Enter');
    await m.getByText('"not-an-email" is not a valid email').waitFor();
    await m.getByRole('button', { name: 'Create group & invite 2' }).click();
    await m.getByText('This is the start of the conversation').waitFor();
  });
  await step('group info: members, map, invite', async () => {
    await m.getByRole('button', { name: 'Group info' }).click(); await m.getByTestId('member').first().waitFor();
    await m.getByRole('region', { name: 'Group location' }).waitFor(); await m.getByRole('region', { name: 'Group map' }).waitFor(); await m.getByText('Invite more people').waitFor();
  });
  await step('map page lists authorised groups', async () => {
    await m.goto(BASE + '/map'); await m.getByRole('region', { name: /Map of your groups/ }).waitFor();
    await m.getByRole('link', { name: /Climbing crew/ }).waitFor();
  });
  await m.screenshot({ path: `${SHOTS}/m-map.png` });
  await step('notifications + smart reminder controls', async () => {
    await m.goto(BASE + '/notifications'); await m.getByText('Book swap picnic is on!').waitFor();
    await m.getByRole('tab', { name: /Reminders & settings/ }).click();
    const sw = m.getByRole('switch', { name: 'Smart reminders' }); await sw.waitFor(); assert.equal(await sw.isChecked(), true);
    await sw.uncheck(); await m.waitForTimeout(250); assert.equal(await sw.isChecked(), false);
    await m.getByText('Beta').first().waitFor();
  });
  await m.screenshot({ path: `${SHOTS}/m-settings.png` });
  console.log('Guest · mobile');
  const g = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await g.goto(BASE + '/join/guest-demo');
  await step('invite page shows group + inviter, asks for name only', async () => {
    await g.getByRole('heading', { name: 'Weekend hikers' }).waitFor(); await g.getByText(/Bob Patel invited you/).waitFor();
    await g.getByRole('button', { name: 'Join group' }).click(); await g.getByText(/Tell us your name/).waitFor();
    await g.getByLabel('Your name').fill('Gus'); await g.getByRole('button', { name: 'Join group' }).click();
    await g.getByRole('log').getByText(/Gus joined the group/).waitFor();
  });
  await g.screenshot({ path: `${SHOTS}/g-chat.png` });

  console.log('Lifecycle (fake clock)');
  {
    const l = await mk({ viewport: { width: 390, height: 844 }, isMobile: true });
    await l.clock.install({ time: new Date() });
    await l.goto(BASE + '/login');
    await l.getByRole('button', { name: 'Fill demo login' }).click(); await l.getByRole('button', { name: 'Sign in' }).click();
    await step('event that is about to end is shown', async () => { await l.getByText('Quick coffee').first().waitFor(); });
    await step('after it ends it vanishes from home, pinned strip and chat without reload', async () => {
      await l.getByRole('link', { name: /Book club/ }).click(); await l.getByTestId('pinned').getByText('Quick coffee').waitFor();
      await l.clock.fastForward('04:00'); await l.clock.runFor(25000);
      await l.waitForFunction(() => !document.querySelector('[data-testid=pinned]')?.textContent?.includes('Quick coffee'));
      await l.getByTestId('event-message').filter({ hasText: 'Quick coffee' }).getByRole('button', { name: /Join|Going/ }).waitFor({ state: 'detached' });
      await l.getByRole('button', { name: 'Back' }).click();
      await l.waitForFunction(() => !document.body.textContent?.includes('Quick coffee'));
    });
    await step('its tasks disappear from My tasks', async () => {
      await l.getByRole('link', { name: 'Tasks' }).click(); await l.waitForTimeout(300);
      assert.equal(await l.getByText('Order oat milk').count(), 0);
    });
  }

  console.log('Desktop');
  const d = await mk({ viewport: { width: 1280, height: 800 } });
  await d.goto(BASE + '/login');
  await step('desktop: two-pane layout', async () => {
    await d.getByRole('button', { name: 'Fill demo login' }).click(); await d.getByRole('button', { name: 'Sign in' }).click();
    await d.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: /Climbing crew/ }).waitFor();
    await d.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: /Climbing crew/ }).click();
    await d.getByTestId('pinned').waitFor();
    assert.equal(await d.getByRole('navigation', { name: 'Main' }).count(), 0);
  });
  await d.screenshot({ path: `${SHOTS}/d-chat.png` });
  await step('desktop: event page', async () => {
    await d.getByTestId('pinned').getByRole('link', { name: /Open Bouldering night/ }).click(); await d.getByRole('heading', { name: /Who's going/ }).waitFor();
  });
  await d.screenshot({ path: `${SHOTS}/d-event.png` });

  console.log(errors.length ? 'Console/page errors:\n' + [...new Set(errors)].join('\n') : 'No console errors');
  await browser.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
