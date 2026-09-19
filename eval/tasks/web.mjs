// The web suite: every simulated-site agent task. Each entry carries the ask an
// agent gets, the answerSchema its free-text answer is extracted into, and the
// validate function that grades SERVER-OBSERVED state (plus the extracted
// fields) - never the agent's prose claims alone.
// Imported by run.mjs (the paid runner) and verify.mjs (the free gate), so both
// always grade identical code.
//
// The tasks themselves live in tasks/web/, one module per family, and this file
// concatenates them. Families exist so that adding a task means editing one small
// file, and so concurrent work can partition by file: run.mjs, answers.mjs and
// server.mjs each take a single writer.
//
// Adding a task means adding it to the family it belongs to, writing its
// golden-path driver in verify-drivers/, and running `node verify.mjs`. The rules
// a task and its fixture must satisfy are in docs/authoring-fixtures.md.

import { readFileSync } from 'node:fs';
import { originUrls } from '../../manifest.mjs';
import { commerceTasks } from './web/commerce.mjs';
import { formsTasks } from './web/forms.mjs';
import { authTasks } from './web/auth.mjs';
import { navigationTasks } from './web/navigation.mjs';
import { extractionTasks } from './web/extraction.mjs';
import { recoveryTasks } from './web/recovery.mjs';
import { safetyTasks } from './web/safety.mjs';
import { interactionTasks } from './web/interaction.mjs';

// Keyed by the family module's name, which is what `task.family` carries.
const FAMILIES = {
  commerce: commerceTasks,
  forms: formsTasks,
  auth: authTasks,
  navigation: navigationTasks,
  extraction: extractionTasks,
  recovery: recoveryTasks,
  safety: safetyTasks,
  interaction: interactionTasks,
};

// Capability tags per task id (tasks/areas.json), so a run or the gate can
// select the tasks one tool change touches. The file is derived rather than
// hand-kept: eval/scripts/derive-areas.mjs regenerates it, from inputs its
// header lists, some of which are not in the repo.
let AREAS = null;
export function taskAreas() {
  AREAS ??= JSON.parse(readFileSync(new URL('./areas.json', import.meta.url), 'utf8'));
  return AREAS;
}

// Stamps `family` and `areas` onto every task a factory returns. A task the
// areas file does not know gets an empty list rather than a throw, so a new
// task runs before anyone regenerates the file; verify.mjs --list names it.
export function tagTasks(tasks, family) {
  const areas = taskAreas();
  for (const task of tasks) {
    task.family = family;
    task.areas = [...(areas[task.id] ?? [])];
  }
  return tasks;
}

export async function webTasks(base, origins = originUrls(base)) {
  const families = await Promise.all(
    Object.entries(FAMILIES).map(async ([name, family]) => tagTasks(await family(base, origins), name))
  );
  const tasks = families.flat();
  // A duplicate id would shadow one of the two everywhere a task is looked up by
  // id, and the gate would still pass, because both entries are valid tasks.
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
  return tasks;
}
