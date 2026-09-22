// What still differs when firefox-devtools-mcp and playwright-mcp launch one
// Firefox build, Playwright's (--devtools-firefox playwright): the prefs each
// launcher leaves in the profile, and whether the pinned pdf.js pref holds.
// playwright.cfg's pref() calls run after the profile's user.js, where
// geckodriver writes firefox-devtools-mcp's --pref flags, so only a policy sets
// pdfjs.disabled back there; Playwright sets firefoxUserPrefs again once the
// browser is up. Each launcher's browser loads about:blank and quits, and the
// user prefs its prefs.js then holds are compared by name, leaving out the
// state any profile writes for itself. Measured on firefox-devtools-mcp 0.10.3
// and @playwright/mcp's playwright-core, Firefox 152.0.4, macOS, 2026-09-21.
//
//   node eval/spikes/launch-prefs.mjs

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEnv } from '../agent-env.mjs';
import {
  DEVTOOLS_SERVER_ENV, PINNED_PREFS, devtoolsFirefox, devtoolsFirefoxLaunch, devtoolsMcpEntry, firefoxBuild, prefArgs, startMcpServer,
} from '../mcp-stdio.mjs';
import { findings, packageVersions, sleep, textOf } from './lib.mjs';

// Written by Firefox for any profile, or random per profile.
const PROFILE_STATE =
  /^(app\.update\.lastUpdateTime|browser\.bookmarks|browser\.contextual-services|browser\.laterrun|browser\.migration|browser\.newtabpage\.activity-stream\.(impressionId|newtabWallpapers)|browser\.newtabpage\.storageVersion|browser\.pageActions|browser\.pagethumbnails|browser\.proton|browser\.region|browser\.rights|browser\.safebrowsing\.provider\.[^.]+\.(lastupdatetime|nextupdatetime)|browser\.sessionstore|browser\.startup\.(couldRestoreSession|lastColdStartupCheck)|browser\.termsofuse|browser\.uiCustomization|datareporting|distribution|doh-rollout|dom\.forms\.autocomplete|dom\.push\.userAgentID|extensions\.(activeThemeID|blocklist\.pingCountVersion|databaseSchema|getAddons|lastAppBuildId|lastAppVersion|lastPlatformVersion|pendingOperations|quarantinedDomains|signatureCheckpoint|systemAddonSet|webcompat|webextensions\.(ExtensionStorageIDB|uuids))|gecko\.handlerService|gfx\.|idle\.lastDailyNotification|media\.gmp|network\.trr|nimbus|places\.|privacy\.bounceTrackingProtection|privacy\.purge|security\.sandbox|services\.sync|sidebar\.|storage\.vacuum|termsofuse|toolkit\.profiles\.storeID|toolkit\.startup\.last_success|toolkit\.telemetry\.(cachedClientID|previousBuildID|reportingpolicy)|trailhead)/;

const userPrefs = (path) =>
  Object.fromEntries(
    [...readFileSync(path, 'utf8').matchAll(/^user_pref\("([^"]+)",\s*(.*)\);$/gm)]
      .filter(([, name]) => !PROFILE_STATE.test(name))
      .map(([, name, value]) => [name, value])
  );

const firefox = devtoolsFirefox('playwright');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'zoo-spike-')));

// A firefox-devtools-mcp browser on `firefox`, with the pinned prefs and, when
// `policy`, the policy a paid run adds; its pdf.js reading and user prefs.
async function devtools(name, policy) {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  const launch = policy ? devtoolsFirefoxLaunch(firefox, PINNED_PREFS, dir) : { args: ['--firefox-path', firefox.binary], env: {} };
  const server = await startMcpServer({
    args: [devtoolsMcpEntry(), '--enable-script', '--headless', '--profile-path', dir, ...launch.args, ...prefArgs(PINNED_PREFS)],
    env: { ...DEVTOOLS_SERVER_ENV, ...launch.env },
    baseEnv: agentEnv(null),
    cwd: dir,
  });
  await server.call('navigate_page', { url: 'about:blank' });
  const pdf = /true/.test(textOf(await server.call('evaluate_script', { function: '() => navigator.pdfViewerEnabled' })));
  await server.close();
  await sleep(2500);
  return { pdf, prefs: userPrefs(join(dir, 'firefox_devtools_mcp_profile', 'prefs.js')) };
}

// Playwright's launch of the same build with the pinned prefs, as
// playwright-mcp's config hands them over (launchOptions.firefoxUserPrefs).
async function playwright() {
  const require = createRequire(import.meta.url);
  const mcpRequire = createRequire(require.resolve('@playwright/mcp/package.json'));
  const { firefox: pw } = mcpRequire(mcpRequire.resolve('playwright-core'));
  const dir = mkdtempSync(join(scratch, 'pw-'));
  const context = await pw.launchPersistentContext(dir, { headless: true, firefoxUserPrefs: PINNED_PREFS });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('about:blank');
  const pdf = await page.evaluate(() => navigator.pdfViewerEnabled);
  await context.close();
  await sleep(1500);
  return { pdf, prefs: userPrefs(join(dir, 'prefs.js')) };
}

const title = 'launch prefs: firefox-devtools-mcp and playwright-mcp on one Firefox build';
const f = findings(title);
const v = packageVersions();
const build = firefoxBuild(firefox.binary, 'playwright');
console.log(
  `${title}\nrunning on: firefox-devtools-mcp ${v.devtools} and @playwright/mcp ${v.playwright}, both on Firefox ` +
    `${build?.version ?? '?'} ${build?.buildID ?? '?'} (${firefox.binary})\n`
);
try {
  const bare = await devtools('bare', false);
  const pinned = await devtools('policy', true);
  const pw = await playwright();
  f.record('devtools, --pref pdfjs.disabled=false alone: pdf.js on', bare.pdf, false);
  f.record('devtools, with the policy: pdf.js on', pinned.pdf, true);
  f.record("playwright's launch: pdf.js on", pw.pdf, true);
  const names = (a, b) => Object.keys(a).filter((k) => !(k in b)).sort();
  f.record('prefs only the devtools arm sets (geckodriver, its Remote Agent, the policy)', names(pinned.prefs, pw.prefs), [
    'browser.backup.enabled', 'browser.contentblocking.introCount', 'browser.discovery.enabled', 'browser.dom.window.dump.enabled',
    'browser.http.blank_page_with_error_response.enabled', 'browser.ml.enable',
    'browser.newtabpage.activity-stream.asrouter.providers.cfr', 'browser.newtabpage.activity-stream.asrouter.providers.cfr-fxa',
    'browser.newtabpage.activity-stream.asrouter.providers.message-groups',
    'browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments',
    'browser.newtabpage.activity-stream.asrouter.providers.whats-new-panel',
    'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features', 'browser.newtabpage.activity-stream.discoverystream.config',
    'browser.newtabpage.activity-stream.feeds.snippets', 'browser.newtabpage.activity-stream.fxaccounts.endpoint',
    'browser.newtabpage.activity-stream.testing.shouldInitializeFeeds', 'browser.newtabpage.activity-stream.tippyTop.service.endpoint',
    'browser.policies.applied', 'browser.tabs.remote.unloadDelayMs', 'browser.tabs.unloadOnLowMemory',
    'browser.toolbars.bookmarks.visibility', 'browser.urlbar.merino.endpointURL', 'browser.urlbar.merino.ohttpConfigURL',
    'browser.urlbar.merino.ohttpRelayURL', 'browser.webapps.checkForUpdates', 'devtools.console.stdout.chrome',
    'dom.ipc.processPriorityManager.enabled', 'dom.navigation.navigationRateLimit.count', 'dom.successive_dialog_time_limit',
    'extensions.blocklist.detailsURL', 'extensions.blocklist.itemURL', 'extensions.formautofill.addresses.enabled',
    'extensions.formautofill.creditCards.enabled', 'extensions.hotfix.url', 'extensions.systemAddon.update.enabled',
    'extensions.update.background.url', 'extensions.update.url', 'geo.prompt.open_system_prefs', 'geo.provider.network.url',
    'identity.fxaccounts.auth.uri', 'marionette.port', 'media.sanity-test.disabled', 'mousewheel.allow_scrolling_more_than_one_page',
    'pdfjs.migrationVersion', 'privacy.trackingprotection.pbmode.enabled', 'remote.active-protocols', 'remote.prefs.recommended.applied',
    'security.remote_settings.intermediates.enabled', 'services.settings.loglevel',
    'signon.management.page.breach-alerts.enabled', 'signon.management.page.vulnerable-passwords.enabled',
    'telemetry.fog.test.localhost_port', 'threads.lower_mainthread_priority_in_background.enabled',
    'widget.windows.window_occlusion_tracking.enabled',
  ]);
  f.record("prefs only playwright-mcp's arm sets", names(pw.prefs, pinned.prefs), []);
  const differ = Object.keys(pinned.prefs).filter((k) => k in pw.prefs && pinned.prefs[k] !== pw.prefs[k]).sort();
  f.record('prefs both set, to different values', differ, ['browser.policies.alternatePath', 'pdfjs.enabledCache.state']);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
f.done();
