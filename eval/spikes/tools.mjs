// Probes each condition's tool list and which of its tools no gate driver calls; measured on firefox-devtools-mcp 0.10.3 (Firefox 156.0) and @playwright/mcp 0.0.78 (Firefox 152.0).
//
//   node eval/spikes/tools.mjs              names, plus the devtools tools no driver calls
//   node eval/spikes/tools.mjs <tool>...    also print those tools' descriptions and input schemas

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findings, surface } from './lib.mjs';

const want = new Set(process.argv.slice(2));
// The drivers plus verify.mjs, whose helpers wrap navigate_page and
// evaluate_script for every driver.
const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const driverSource = [
  join(evalDir, 'verify.mjs'),
  ...readdirSync(join(evalDir, 'verify-drivers'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(evalDir, 'verify-drivers', f)),
]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const log = findings('Tool lists and the devtools tools no gate driver calls');
const surfaces = [await surface('devtools'), await surface('playwright')];
await log.header(...surfaces);

const MEASURED = {
  devtools: {
    // 0.10.3 against 0.9.15: restart_firefox moved to a Mozilla-internal
    // build; close_firefox_session, get_page_text, press_key,
    // set_network_cache and type_text are new.
    tools: [
      'accept_dialog', 'clear_console_messages', 'clear_downloads', 'clear_snapshot', 'click_by_uid',
      'close_firefox_session', 'close_page', 'dismiss_dialog', 'drag_by_uid_to_uid', 'enable_debugger',
      'evaluate_script', 'fill_by_uid', 'fill_form_by_uid', 'get_firefox_info', 'get_firefox_output',
      'get_logpoint_results', 'get_network_request', 'get_page_text', 'get_script_source', 'hover_by_uid',
      'install_extension', 'list_console_messages', 'list_downloads', 'list_network_requests',
      'list_pages', 'list_scripts', 'navigate_history', 'navigate_page', 'new_page', 'press_key',
      'profiler_is_active', 'profiler_start', 'profiler_stop', 'remove_logpoint',
      'resolve_uid_to_selector', 'screencast_start', 'screencast_stop',
      'screenshot_by_uid', 'screenshot_page', 'select_page', 'set_download_behavior',
      'set_logpoint', 'set_network_cache', 'set_viewport_size', 'take_snapshot', 'type_text',
      'uninstall_extension', 'upload_file_by_uid',
    ],
    unexercised: [
      'clear_console_messages', 'clear_downloads', 'clear_snapshot', 'close_firefox_session',
      'enable_debugger', 'get_firefox_info', 'get_firefox_output',
      'get_logpoint_results', 'get_page_text', 'get_script_source', 'install_extension',
      'list_downloads', 'list_scripts', 'new_page', 'press_key', 'profiler_is_active',
      'profiler_start', 'profiler_stop', 'remove_logpoint', 'screencast_start',
      'screencast_stop', 'screenshot_by_uid', 'screenshot_page', 'set_download_behavior',
      'set_logpoint', 'set_network_cache', 'type_text', 'uninstall_extension',
    ],
  },
  playwright: {
    tools: [
      'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
      'browser_evaluate', 'browser_file_upload', 'browser_fill_form', 'browser_find',
      'browser_handle_dialog', 'browser_hover', 'browser_navigate', 'browser_navigate_back',
      'browser_network_request', 'browser_network_requests', 'browser_press_key', 'browser_resize',
      'browser_run_code_unsafe', 'browser_select_option', 'browser_snapshot', 'browser_tabs',
      'browser_take_screenshot', 'browser_type', 'browser_wait_for',
    ],
  },
};

for (const s of surfaces) {
  const tools = await s.tools();
  const names = tools.map((t) => t.name).sort();
  log.record(`${s.name} tools`, names, MEASURED[s.name].tools);
  if (s.name === 'devtools') {
    const unexercised = names.filter((n) => !new RegExp(`['"]${n}['"]`).test(driverSource));
    log.record('devtools tools no driver calls', unexercised, MEASURED.devtools.unexercised);
  }
  for (const t of tools.filter((x) => want.has(x.name))) {
    console.log(`== ${s.name}.${t.name}\n${t.description}\n${JSON.stringify(t.inputSchema?.properties, null, 1)}\n`);
  }
  await s.close();
}
log.done();
