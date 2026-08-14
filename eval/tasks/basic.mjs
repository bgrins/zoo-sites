// The three smoke tasks: prove an agent can drive the browser at all.
// Factory contract: (base) => task[] - see web.mjs for the full field set.
import { originUrls } from '../../manifest.mjs';
import { ANSWERS } from '../answers.mjs';

export function basicTasks(base, origins = originUrls(base)) {
  return [
    {
      id: 'title',
      ask: `Open ${origins.basic}/title.html in the browser. Report the exact page title.`,
      expect: new RegExp(ANSWERS.basic.title),
    },
    {
      id: 'click-reveal',
      ask:
        `Open ${origins.basic}/click-reveal.html in the browser. Click the "Reveal code" ` +
        `button and report the code that appears.`,
      expect: new RegExp(ANSWERS.basic.revealCode),
    },
    {
      id: 'form-fill',
      ask:
        `Open ${origins.basic}/form-fill.html in the browser. Type "Marmalade" into the ` +
        `name field, click the Greet button, and report the greeting text that appears.`,
      expect: new RegExp(ANSWERS.basic.greeting),
    },
  ];
}
