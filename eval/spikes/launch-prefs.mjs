// What still differs when firefox-devtools-mcp and playwright-mcp launch one
// Firefox build, Playwright's (--devtools-firefox playwright): the prefs each
// launcher leaves in the profile, and whether the pinned pdf.js pref holds.
// playwright.cfg's pref() calls run after the profile's user.js, where
// geckodriver writes firefox-devtools-mcp's --pref flags, so only a policy sets
// pdfjs.disabled back there; Playwright sets firefoxUserPrefs again once the
// browser is up. Each launcher's browser loads about:blank and quits, and the
// user prefs its prefs.js then holds are compared by name, leaving out the
// state any profile writes for itself. Since Firefox 158 (bug 2074275) the
// Remote Agent sets its recommended prefs on the default branch, so prefs.js
// shows none of them and drops any user value that matches one. Measured on
// firefox-devtools-mcp 0.10.7 and @playwright/mcp 0.0.85's playwright-core
// 1.66.0-alpha-2026-11-09, Firefox 159.0, macOS, 2026-11-10.
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
    'browser.dom.window.dump.enabled', 'browser.newtabpage.activity-stream.asrouter.providers.cfr',
    'browser.newtabpage.activity-stream.asrouter.providers.cfr-fxa',
    'browser.newtabpage.activity-stream.asrouter.providers.message-groups',
    'browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments',
    'browser.newtabpage.activity-stream.asrouter.providers.whats-new-panel',
    'browser.newtabpage.activity-stream.discoverystream.config', 'browser.newtabpage.activity-stream.feeds.snippets',
    'browser.newtabpage.activity-stream.fxaccounts.endpoint', 'browser.newtabpage.activity-stream.tippyTop.service.endpoint',
    'browser.policies.applied', 'browser.webapps.checkForUpdates', 'devtools.console.stdout.chrome', 'marionette.port',
    'media.sanity-test.disabled', 'pdfjs.migrationVersion', 'remote.active-protocols',
  ]);
  // playwright.cfg's copy of the Remote Agent's recommended prefs (152.0.4's
  // cfg had none): the devtools arm runs with the same values, as defaults.
  f.record("prefs only playwright-mcp's arm sets", names(pw.prefs, pinned.prefs), [
    'app.normandy.api_url', 'app.update.disabledForTesting', 'apz.axis_lock.mode', 'apz.content_response_timeout',
    'apz.touch_move_tolerance', 'apz.touch_start_tolerance', 'browser.backup.enabled', 'browser.discovery.enabled',
    'browser.download.alwaysOpenPanel', 'browser.download.panel.shown', 'browser.http.blank_page_with_error_response.enabled',
    'browser.ml.enable', 'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features',
    'browser.newtabpage.activity-stream.showSponsoredTopSites',
    'browser.newtabpage.activity-stream.testing.shouldInitializeFeeds', 'browser.preonboarding.enabled',
    'browser.safebrowsing.blockedURIs.enabled', 'browser.safebrowsing.downloads.enabled', 'browser.safebrowsing.malware.enabled',
    'browser.safebrowsing.phishing.enabled', 'browser.search.update', 'browser.shell.checkDefaultBrowser',
    'browser.startup.homepage_override.mstone', 'browser.tabs.remote.unloadDelayMs', 'browser.tabs.unloadOnLowMemory',
    'browser.tabs.warnOnCloseOtherTabs', 'browser.tabs.warnOnOpen', 'browser.toolbars.bookmarks.visibility',
    'browser.topsites.contile.enabled', 'browser.translations.enable', 'browser.urlbar.merino.endpointURL',
    'browser.urlbar.merino.ohttpConfigURL', 'browser.urlbar.merino.ohttpRelayURL', 'browser.urlbar.suggest.searches',
    'browser.usedOnWindows10.introURL', 'browser.warnOnQuit', 'dom.disable_open_during_load', 'dom.file.createInChild',
    'dom.input_events.security.minNumTicks', 'dom.input_events.security.minTimeElapsedInMS',
    'dom.ipc.processPriorityManager.enabled', 'dom.ipc.reportProcessHangs', 'dom.max_script_run_time',
    'dom.navigation.navigationRateLimit.count', 'dom.permissions.testing.enabled', 'dom.push.connection.enabled',
    'dom.successive_dialog_time_limit', 'extensions.autoDisableScopes', 'extensions.enabledScopes',
    'extensions.formautofill.addresses.enabled', 'extensions.formautofill.creditCards.enabled', 'extensions.installDistroAddons',
    'extensions.systemAddon.update.enabled', 'extensions.update.enabled', 'extensions.update.notifyUser', 'focusmanager.testmode',
    'general.useragent.updates.enabled', 'geo.prompt.open_system_prefs', 'geo.provider.network.url', 'geo.provider.testing',
    'geo.wifi.scan', 'mousewheel.allow_scrolling_more_than_one_page', 'network.captive-portal-service.enabled',
    'network.connectivity-service.enabled', 'network.manage-offline-status', 'permissions.isolateBy.userContext',
    'privacy.trackingprotection.pbmode.enabled', 'security.certerrors.mitm.priming.enabled',
    'security.fileuri.strict_origin_policy', 'security.notification_enable_delay',
    'security.webauthn.related_origin_requests_mode', 'services.settings.loglevel', 'services.settings.server',
    'signon.autofillForms', 'signon.management.page.breach-alerts.enabled', 'signon.management.page.vulnerable-passwords.enabled',
    'signon.rememberSignons', 'startup.homepage_welcome_url', 'telemetry.fog.test.localhost_port',
    'threads.lower_mainthread_priority_in_background.enabled', 'toolkit.startup.max_resumed_crashes',
    'widget.windows.window_occlusion_tracking.enabled',
  ]);
  const differ = Object.keys(pinned.prefs).filter((k) => k in pw.prefs && pinned.prefs[k] !== pw.prefs[k]).sort();
  f.record('prefs both set, to different values', differ, ['browser.policies.alternatePath', 'pdfjs.enabledCache.state']);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
f.done();
