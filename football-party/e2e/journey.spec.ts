import { expect, test, type Browser, type Page } from '@playwright/test';
import { FootballIndex } from '../shared/football';
import { sampleDataset } from '../data/sample/sample';

const idx = new FootballIndex(sampleDataset);

async function newPlayer(
  browser: Browser,
  use: {
    viewport?: { width: number; height: number } | null;
    hasTouch?: boolean;
    isMobile?: boolean;
  },
) {
  const ctx = await browser.newContext({
    viewport: use.viewport ?? undefined,
    hasTouch: use.hasTouch,
    isMobile: use.isMobile,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    throw new Error(`page error: ${e.message}`);
  });
  return page;
}

async function createRoom(page: Page, name: string) {
  await page.goto('/play');
  await page.getByRole('textbox', { name: 'Your nickname' }).first().fill(name);
  await page.getByRole('button', { name: /create room/i }).click();
  await expect(page).toHaveURL(/\/r\/[A-Z0-9]{5}$/);
  const code = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { name: 'Squad', exact: true })).toBeVisible();
  return code;
}

async function joinRoom(page: Page, code: string, name: string) {
  await page.goto('/play');
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('textbox', { name: 'Your nickname' }).last().fill(name);
  await page.getByRole('button', { name: /join room/i }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${code}$`));
  await expect(page.getByRole('heading', { name: 'Squad', exact: true })).toBeVisible();
}

test('landing explains the product and links into play', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/faker/i);
  await expect(page.getByText(/sample/i).first()).toBeVisible();
  await page.getByRole('link', { name: /start a room/i }).click();
  await expect(page).toHaveURL(/\/play/);
});

test('invalid and unknown room codes are handled', async ({ page }) => {
  await page.goto('/play');
  await page.getByLabel('Room code').fill('AB');
  await page.getByRole('textbox', { name: 'Your nickname' }).last().fill('Zed');
  await page.getByRole('button', { name: /join room/i }).click();
  await expect(page.getByRole('alert').first()).toContainText(/5 characters/);
  await page.goto('/r/ZZZZZ');
  await expect(page.getByRole('heading', { name: /no room/i })).toBeVisible();
  await page.goto('/r/xx');
  await expect(page.getByRole('heading', { name: /not a room code/i })).toBeVisible();
});

test('football impostor: full multiplayer round across three devices', async ({
  browser,
}, info) => {
  const use = info.project.use;
  const [host, ben, cy] = await Promise.all([
    newPlayer(browser, use),
    newPlayer(browser, use),
    newPlayer(browser, use),
  ]);
  const code = await createRoom(host, 'Hosty');
  await joinRoom(ben, code, 'Ben');
  await joinRoom(cy, code, 'Cyd');
  await expect(host.getByText('Cyd')).toBeVisible(); // roster syncs live

  // single round, one clue lap
  await host.getByText('Advanced: timers & hints').click();
  for (const label of ['Rounds', 'Clue laps']) {
    const out = host.getByRole('group', { name: label }).locator('output');
    while (Number(await out.innerText()) > 1) {
      const before = await out.innerText();
      await host.getByRole('button', { name: `Decrease ${label}` }).click();
      await expect(out).not.toHaveText(before); // wait for the server to confirm the change
    }
  }
  await host.getByRole('button', { name: /kick off football impostor/i }).click();
  const all = [host, ben, cy];

  // reveal: everyone peeks privately and confirms
  const roles: string[] = [];
  let secret = '';
  for (const p of all) {
    await p.getByRole('button', { name: /show my role/i }).click();
    const isImp = (await p.locator('.role-card.is-impostor').count()) > 0;
    if (!isImp) secret = (await p.locator('.role-big.name').innerText()).trim();
    roles.push(isImp ? 'impostor' : 'crew');
    await p.getByRole('button', { name: /got it/i }).click();
  }
  expect(roles.filter((r) => r === 'impostor')).toHaveLength(1);
  // crew show a name; the impostor's page must not
  const impIdx = roles.indexOf('impostor');
  expect(await all[impIdx]!.content()).not.toContain(secret);

  // clues: whoever's turn it is submits
  for (let turn = 0; turn < 3; turn++) {
    const turnPage = await Promise.race(
      all.map(
        async (p) => (
          await p
            .getByRole('textbox', { name: /one word/i })
            .waitFor({ state: 'visible', timeout: 15_000 }),
          p
        ),
      ),
    );
    await turnPage.getByRole('textbox', { name: /one word/i }).fill('left foot');
    await turnPage.getByRole('button', { name: /drop the clue/i }).click();
    await expect(turnPage.getByRole('textbox', { name: /one word/i })).toBeHidden(); // turn moved on
  }
  await expect(host.getByRole('heading', { name: /half-time/i })).toBeVisible();
  await host.getByRole('button', { name: /skip to voting/i }).click();
  for (const p of all) {
    await expect(p.getByRole('heading', { name: /var check/i })).toBeVisible();
    await p.getByRole('radio').first().click();
  }
  await expect(host.getByText('The footballer was')).toBeVisible();
  await expect(ben.getByText('The footballer was')).toBeVisible();
  await expect(host.getByText(secret).first()).toBeVisible();
  await host.getByRole('button', { name: /final standings/i }).click();
  await expect(cy.getByText(/full-time/i).first()).toBeVisible();
  await expect(host.getByRole('button', { name: /rematch/i })).toBeVisible();
  await host.getByRole('button', { name: /rematch/i }).click();
  await expect(ben.getByRole('heading', { name: /kick-off/i })).toBeVisible(); // rematch reaches everyone
  for (const p of all) await p.context().close();
});

test('football tic-tac-toe: server-validated answers across two devices, with reconnect', async ({
  browser,
}, info) => {
  const use = info.project.use;
  const [host, guest] = await Promise.all([newPlayer(browser, use), newPlayer(browser, use)]);
  const code = await createRoom(host, 'Xena');
  await joinRoom(guest, code, 'Otto');
  await host.getByRole('radio', { name: /tic-tac-toe/i }).click();
  await host.getByRole('radio', { name: 'Easy · many answers' }).click();
  await host.getByRole('button', { name: /kick off football tic-tac-toe/i }).click();
  await expect(guest.getByRole('grid')).toBeVisible();

  const labelOf = async (p: Page, i: number) =>
    (await p.getByRole('gridcell').nth(i).getAttribute('aria-label'))!.split(': ')[0]!;
  const byLabel = (name: string) => {
    const t = [...idx.dataset.teams].find((x) => x.name === name);
    if (t) return idx.criterionFor(t.kind === 'club' ? 'club' : 'national', t.id)!;
    const c = idx.dataset.competitions.find((x) => x.name === name)!;
    return idx.criterionFor('league', c.id)!;
  };
  const answerFor = async (p: Page, cell: number) => {
    const [r, c] = (await labelOf(p, cell)).split(' × ');
    return idx.card(idx.validAnswers(byLabel(r!), byLabel(c!))[0]!)!.name;
  };

  // The host is player 1 (X) and X always opens round 1.
  const mover = host;
  const other = guest;
  await expect(mover.getByText('Pick a square')).toBeVisible();
  await expect(other.getByText(/is thinking/i)).toBeVisible();

  // wrong turn is refused with feedback; right turn accepted & mirrored to the other device
  await other.getByRole('gridcell').first().dispatchEvent('click'); // aria-disabled: not their turn
  await expect(other.getByText(/turn/i).first()).toBeVisible();
  await mover.getByRole('gridcell').first().click();
  const name = await answerFor(mover, 0);
  const search = mover.getByRole('combobox', { name: /search footballers/i });
  await search.fill(name.slice(0, 4));
  await mover.getByRole('option', { name }).click();
  await expect(other.getByRole('gridcell').first()).toHaveAttribute('aria-label', new RegExp(name));
  await expect(other.getByText('Pick a square')).toBeVisible();

  // refresh = reconnect with the same seat and state
  await other.reload();
  await expect(other.getByRole('gridcell').first()).toHaveAttribute('aria-label', new RegExp(name));
  await expect(other.getByText('Pick a square')).toBeVisible();

  // invalid answer: a footballer who doesn't fit loses the turn
  await other.getByRole('gridcell').nth(4).click();
  const [r4, c4] = (await labelOf(other, 4)).split(' × ');
  const bad = idx
    .allPlayers()
    .find((p) => !idx.verdict(p.id, byLabel(r4!)).ok && !idx.verdict(p.id, byLabel(c4!)).ok)!;
  await other.getByRole('combobox', { name: /search footballers/i }).fill(bad.name.slice(0, 5));
  await other
    .getByRole('option', { name: new RegExp(bad.name.replace(/[()]/g, '')) })
    .first()
    .click();
  await expect(mover.locator('.event.rejected')).toBeVisible();
  await expect(other.getByRole('gridcell').nth(4)).toHaveAttribute('aria-label', /empty/);
  for (const p of [host, guest]) await p.context().close();
});

test('search shows an empty state for unknown players', async ({ browser }, info) => {
  const page = await newPlayer(browser, info.project.use);
  await page.goto('/party/tictactoe');
  await page.getByRole('radio', { name: 'Computer', exact: true }).click();
  await page.getByRole('button', { name: /kick off/i }).click();
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.getByText('Pick a square')).toBeVisible();
  await page.getByRole('gridcell').first().click();
  await page.getByRole('combobox', { name: /search footballers/i }).fill('qqqqzzzz');
  await expect(page.getByText(/no footballers match/i)).toBeVisible();
  await page.context().close();
});

const byLabel = (name: string) => {
  const t = idx.dataset.teams.find((x) => x.name === name);
  if (t) return idx.criterionFor(t.kind === 'club' ? 'club' : 'national', t.id)!;
  return idx.criterionFor('league', idx.dataset.competitions.find((x) => x.name === name)!.id)!;
};

test('one-phone party: play a move against the computer', async ({ browser }, info) => {
  const page = await newPlayer(browser, info.project.use);
  await page.goto('/party/tictactoe');
  await page.getByRole('radio', { name: 'Computer', exact: true }).click();
  await page.getByRole('button', { name: /kick off/i }).click();
  await expect(page.getByText(/not.*online multiplayer/i).first()).toBeVisible();
  const label = (await page.getByRole('gridcell').first().getAttribute('aria-label'))!.split(
    ': ',
  )[0]!;
  const [r, c] = label.split(' × ');
  const name = idx.card(idx.validAnswers(byLabel(r!), byLabel(c!))[0]!)!.name;
  await page.getByRole('gridcell').first().click();
  await page.getByRole('combobox', { name: /search footballers/i }).fill(name);
  await page.getByRole('option', { name }).click();
  await expect(page.getByRole('gridcell').first()).toHaveAttribute('aria-label', new RegExp(name));
  await page.context().close();
});

test('one-phone party: three friends share the phone in Tic-Tac-Toe (teams alternate, no hand-over screens)', async ({
  browser,
}, info) => {
  const page = await newPlayer(browser, info.project.use);
  await page.goto('/party/tictactoe');
  await expect(page.getByText(/X\s*Player 1, Player 3/)).toBeVisible(); // team preview
  await page.getByRole('button', { name: /kick off/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); // nothing secret, so nothing to hide
  await expect(page.getByRole('grid')).toBeVisible();
  const [r, c] = (await page.getByRole('gridcell').first().getAttribute('aria-label'))!
    .split(': ')[0]!
    .split(' × ');
  const name = idx.card(idx.validAnswers(byLabel(r!), byLabel(c!))[0]!)!.name;
  await page.getByRole('gridcell').first().click();
  await page.getByRole('combobox', { name: /search footballers/i }).fill(name);
  await page.getByRole('option', { name }).click();
  // straight on to the next team's turn (Player 2), same screen
  await expect(page.getByRole('gridcell').first()).toHaveAttribute('aria-label', new RegExp(name));
  await expect(page.getByText('Pick a square')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.context().close();
});

test('one-phone party: Impostor deals cards one tap at a time, clues are spoken, the group decides', async ({
  browser,
}, info) => {
  const page = await newPlayer(browser, info.project.use);
  await page.goto('/party/impostor');
  await page.getByRole('radio', { name: 'Off — take your time' }).click();
  await page.getByRole('button', { name: /kick off/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); // no hand-over screens at all
  let secret = '';
  const seen: string[] = [];
  for (let i = 1; i <= 3; i++) {
    // face-down card shows only the player's name; nothing of the previous secret is in the page
    await expect(
      page.getByRole('button', { name: new RegExp(`player ${i}.*tap to see`, 'i') }),
    ).toBeVisible();
    if (secret) expect(await page.content()).not.toContain(secret);
    await page.getByRole('button', { name: new RegExp(`player ${i}.*tap to see`, 'i') }).click();
    const imp = (await page.locator('.deal-card.is-impostor').count()) > 0;
    seen.push(imp ? 'impostor' : 'crew');
    if (!imp) secret = (await page.locator('.deal-card .role-big.name').innerText()).trim();
    await page.getByRole('button', { name: /got it — pass the phone on/i }).click();
  }
  expect(seen.filter((x) => x === 'impostor')).toHaveLength(1);
  // Clues are said out loud: no text box, just "next speaker".
  await expect(page.getByText(/give your clue/i).first()).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /done — /i }).click();
  await expect(page.getByRole('heading', { name: /half-time/i })).toBeVisible();
  await page.getByRole('button', { name: /skip to voting/i }).click();
  // The group points; one tap on the phone gives the verdict.
  await page.getByRole('radio', { name: /player 1/i }).click();
  await page.getByRole('button', { name: /^reveal$/i }).click();
  await expect(page.getByText('The footballer was')).toBeVisible();
  await expect(page.getByText(secret).first()).toBeVisible();
  await page.context().close();
});

test('play hub offers one-phone and online modes', async ({ page }) => {
  await page.goto('/play');
  await expect(page.getByRole('link', { name: /one phone party mode/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /create room/i })).toBeVisible();
  await page.goto('/practice/impostor'); // legacy links keep working
  await expect(page).toHaveURL(/\/party\/impostor/);
});

test('installable PWA metadata is served', async ({ request }) => {
  const m = await (await request.get('/manifest.webmanifest')).json();
  expect(m.display).toBe('standalone');
  expect((await request.get('/icons/icon-512.png')).ok()).toBe(true);
  expect((await request.get('/sw.js')).ok()).toBe(true);
});
