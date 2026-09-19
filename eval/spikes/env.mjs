// Probes each condition's browser environment as a page and its server see it (Firefox version, user agent, Accept-Language, locale, time zone, viewport, colour scheme); measured on firefox-devtools-mcp 0.9.15 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
// A paid run compares the two conditions as if only the tool surface
// differed; every difference printed here is a confound until run.mjs pins or
// records it.
//
// Time zone and colour scheme follow the host unless a condition pins them, so
// both compare against the host's own values rather than against the machine
// they were first measured on (America/Los_Angeles, dark mode).

import { execFileSync } from 'node:child_process';
import { findings, page, probeServer, surface } from './lib.mjs';

const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// macOS is the one host with a single setting to read; elsewhere the scheme is
// printed but not compared.
const hostDark = (() => {
  if (process.platform !== 'darwin') return null;
  try {
    const style = execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return style.trim() === 'Dark';
  } catch {
    return false;
  }
})();

const probe = await probeServer({ '/env': page('Environment', '<p>ok</p>') });
const log = findings('Browser environment per condition');

const dt = await surface('devtools');
const pw = await surface('playwright');
await dt.navigate(probe.url + '/env');
await pw.navigate(probe.url + '/env');
await log.header(dt, pw);
console.log(
  `host: time zone ${hostTimeZone}, colour scheme ` +
    `${hostDark === null ? 'unread (not compared)' : hostDark ? 'dark' : 'light'}\n`
);

// The devtools browser is the system Firefox and takes the OS dark mode, while
// playwright's build forces light. `host` stands for the host's own value.
const MEASURED = {
  devtools: {
    firefox: '156.0', acceptLanguage: 'en-US,en;q=0.9', locale: 'en-US', timeZone: 'host',
    viewport: '1366x683', dark: 'host', webdriver: true,
  },
  playwright: {
    firefox: '152.0', acceptLanguage: 'en-US,en;q=0.9', locale: 'en-US', timeZone: 'host',
    viewport: '1280x720', dark: false, webdriver: true,
  },
};

for (const s of [dt, pw]) {
  probe.requests.length = 0;
  await s.navigate(probe.url + '/env');
  const req = probe.requests.find((r) => r.path === '/env');
  const inPage = await s.evaluate(() => ({
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: `${innerWidth}x${innerHeight}`,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    webdriver: navigator.webdriver,
  }));
  const measured = { ...MEASURED[s.name] };
  const observed = {
    firefox: await s.firefox(),
    acceptLanguage: req?.headers['accept-language'] ?? null,
    ...inPage,
    timeZone: inPage.timeZone === hostTimeZone ? 'host' : inPage.timeZone,
  };
  if (measured.dark === 'host' && hostDark === null) {
    delete measured.dark;
    delete observed.dark;
  } else if (measured.dark === 'host' && observed.dark === hostDark) {
    observed.dark = 'host';
  }
  log.record(`${s.name} environment`, observed, measured);
}

await dt.close();
await pw.close();
await probe.close();
log.done();
