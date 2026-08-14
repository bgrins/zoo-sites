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

import { originUrls } from '../../manifest.mjs';
import { commerceTasks } from './web/commerce.mjs';
import { formsTasks } from './web/forms.mjs';
import { authTasks } from './web/auth.mjs';
import { navigationTasks } from './web/navigation.mjs';
import { extractionTasks } from './web/extraction.mjs';
import { recoveryTasks } from './web/recovery.mjs';
import { safetyTasks } from './web/safety.mjs';
import { interactionTasks } from './web/interaction.mjs';

const FAMILIES = [
  commerceTasks,
  formsTasks,
  authTasks,
  navigationTasks,
  extractionTasks,
  recoveryTasks,
  safetyTasks,
  interactionTasks,
];

export async function webTasks(base, origins = originUrls(base)) {
  const families = await Promise.all(FAMILIES.map((family) => family(base, origins)));
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
