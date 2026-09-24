// Golden-path drivers, split by fixture family so several can be authored in
// parallel without conflicting. Each module exports a DRIVERS object; this file
// merges them and fails loudly on a duplicate task id.
//
// See probes.mjs for the driver contract and worked examples.

import { DRIVERS as probes } from './probes.mjs';
import { DRIVERS as basic } from './basic.mjs';
import { DRIVERS as shop } from './shop.mjs';
import { DRIVERS as forms } from './forms.mjs';
import { DRIVERS as formsUpload } from './forms-upload.mjs';
import { DRIVERS as content } from './content.mjs';
import { DRIVERS as auth } from './auth.mjs';
import { DRIVERS as data } from './data.mjs';
import { DRIVERS as gadgetronMirror } from './gadgetron-mirror.mjs';
import { DRIVERS as floorplan } from './floorplan.mjs';
import { DRIVERS as consent } from './consent.mjs';
import { DRIVERS as govNavigation } from './gov-navigation.mjs';
import { DRIVERS as flakySlow } from './flaky-slow.mjs';
import { DRIVERS as viewport } from './viewport.mjs';
import { DRIVERS as paylink } from './paylink.mjs';
import { DRIVERS as forge } from './forge.mjs';
import { DRIVERS as support } from './support.mjs';
import { DRIVERS as schedule } from './schedule.mjs';
import { DRIVERS as auction } from './auction.mjs';
import { DRIVERS as calc } from './calc.mjs';
import { DRIVERS as metrics } from './metrics.mjs';
import { DRIVERS as consoleLog } from './console.mjs';
import { DRIVERS as intl } from './intl.mjs';
import { DRIVERS as roles } from './roles.mjs';
import { DRIVERS as kanban } from './kanban.mjs';
import { DRIVERS as vault } from './vault.mjs';
import { DRIVERS as media } from './media.mjs';
import { DRIVERS as status } from './status.mjs';
import { DRIVERS as smarthome } from './smarthome.mjs';
import { DRIVERS as insure } from './insure.mjs';
import { DRIVERS as bistro } from './bistro.mjs';
import { DRIVERS as cabins } from './cabins.mjs';
import { DRIVERS as depot } from './depot.mjs';
import { DRIVERS as quotient } from './quotient.mjs';
import { DRIVERS as boxoffice } from './boxoffice.mjs';
import { DRIVERS as jobs } from './jobs.mjs';
import { DRIVERS as fernwood } from './fernwood.mjs';
import { DRIVERS as registrar } from './registrar.mjs';
import { DRIVERS as telco } from './telco.mjs';
import { DRIVERS as utility } from './utility.mjs';
import { DRIVERS as kiosk } from './kiosk.mjs';
import { DRIVERS as resendReceipt } from './resend-receipt.mjs';
import { DRIVERS as unsavedLeave } from './unsaved-leave.mjs';
import { DRIVERS as reusedRow } from './reused-row.mjs';
import { DRIVERS as hovercardOncall } from './hovercard-oncall.mjs';
import { DRIVERS as nativePermit } from './native-permit.mjs';
import { DRIVERS as pointerDrag } from './pointer-drag.mjs';
import { DRIVERS as rangeSelect } from './range-select.mjs';
import { DRIVERS as pdfBill } from './pdf-bill.mjs';

// Keyed by file name, which is what the duplicate-id error and DRIVER_FILES
// report.
const modules = {
  'probes.mjs': probes,
  'basic.mjs': basic,
  'shop.mjs': shop,
  'forms.mjs': forms,
  'forms-upload.mjs': formsUpload,
  'content.mjs': content,
  'auth.mjs': auth,
  'data.mjs': data,
  'gadgetron-mirror.mjs': gadgetronMirror,
  'floorplan.mjs': floorplan,
  'consent.mjs': consent,
  'gov-navigation.mjs': govNavigation,
  'flaky-slow.mjs': flakySlow,
  'viewport.mjs': viewport,
  'paylink.mjs': paylink,
  'forge.mjs': forge,
  'support.mjs': support,
  'schedule.mjs': schedule,
  'auction.mjs': auction,
  'calc.mjs': calc,
  'console.mjs': consoleLog,
  'intl.mjs': intl,
  'kanban.mjs': kanban,
  'metrics.mjs': metrics,
  'roles.mjs': roles,
  'vault.mjs': vault,
  'media.mjs': media,
  'status.mjs': status,
  'smarthome.mjs': smarthome,
  'insure.mjs': insure,
  'bistro.mjs': bistro,
  'cabins.mjs': cabins,
  'depot.mjs': depot,
  'quotient.mjs': quotient,
  'boxoffice.mjs': boxoffice,
  'fernwood.mjs': fernwood,
  'registrar.mjs': registrar,
  'telco.mjs': telco,
  'jobs.mjs': jobs,
  'utility.mjs': utility,
  'kiosk.mjs': kiosk,
  'resend-receipt.mjs': resendReceipt,
  'unsaved-leave.mjs': unsavedLeave,
  'reused-row.mjs': reusedRow,
  'hovercard-oncall.mjs': hovercardOncall,
  'native-permit.mjs': nativePermit,
  'pointer-drag.mjs': pointerDrag,
  'range-select.mjs': rangeSelect,
  'pdf-bill.mjs': pdfBill,
};

export const DRIVERS = {};
// The file each task's driver lives in, which verify.mjs --affected maps a
// changed driver file back through.
export const DRIVER_FILES = {};
for (const [file, mod] of Object.entries(modules)) {
  for (const [id, driver] of Object.entries(mod)) {
    if (DRIVER_FILES[id]) {
      throw new Error(`duplicate golden-path driver for "${id}" in ${file} and ${DRIVER_FILES[id]}`);
    }
    DRIVER_FILES[id] = file;
    DRIVERS[id] = driver;
  }
}
