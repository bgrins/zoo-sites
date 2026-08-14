// Registry of per-site backends; see README.md for the module contract.
// site imports
import * as gallery from './gallery.mjs';
import * as filemgr from './filemgr.mjs';
import * as intl from './intl.mjs';
import * as grid_edit from './grid-edit.mjs';
import * as news from './news.mjs';
import * as consent from './consent.mjs';
import * as unsub from './unsub.mjs';
import * as biglist from './biglist.mjs';
import * as ledger from './ledger.mjs';
import * as gov from './gov.mjs';
import * as shop from './shop.mjs';
import * as portal from './portal.mjs';
import * as flaky from './flaky.mjs';
import * as maze from './maze.mjs';
import * as press from './press.mjs';
import * as parcels from './parcels.mjs';
import * as auction from './auction.mjs';
import * as support from './support.mjs';
import * as paylink from './paylink.mjs';
import * as schedule from './schedule.mjs';
import * as forge from './forge.mjs';
import * as calc from './calc.mjs';
import * as kanban from './kanban.mjs';
import * as console from './console.mjs';
import * as metrics from './metrics.mjs';
import * as roles from './roles.mjs';
import * as media from './media.mjs';
import * as vault from './vault.mjs';
import * as office_finder from './office-finder.mjs';
import * as forms from './forms.mjs';
import * as bank from './bank.mjs';
import * as intake from './intake.mjs';
import * as floorplan from './floorplan.mjs';
import * as canvas from './canvas.mjs';
import * as promo from './promo.mjs';
import * as lexvane from './lexvane.mjs';
import * as shadow from './shadow.mjs';
import * as boxoffice from './boxoffice.mjs';
import * as cabins from './cabins.mjs';
import * as bistro from './bistro.mjs';
import * as quotient from './quotient.mjs';
import * as status from './status.mjs';
import * as depot from './depot.mjs';
import * as smarthome from './smarthome.mjs';
import * as insure from './insure.mjs';
import * as fernwood from './fernwood.mjs';
import * as registrar from './registrar.mjs';
import * as telco from './telco.mjs';
import * as utility from './utility.mjs';
import * as jobs from './jobs.mjs';
import * as kiosk from './kiosk.mjs';

export const SITES = [
  gallery.routes,
  filemgr.routes,
  intl.routes,
  grid_edit.routes,
  news.routes,
  consent.routes,
  unsub.routes,
  biglist.routes,
  ledger.routes,
  gov.routes,
  shop.routes,
  portal.routes,
  flaky.routes,
  maze.routes,
  press.routes,
  parcels.routes,
  auction.routes,
  support.routes,
  paylink.routes,
  schedule.routes,
  forge.routes,
  calc.routes,
  kanban.routes,
  console.routes,
  metrics.routes,
  roles.routes,
  media.routes,
  vault.routes,
  office_finder.routes,
  forms.routes,
  bank.routes,
  intake.routes,
  floorplan.routes,
  canvas.routes,
  promo.routes,
  lexvane.routes,
  shadow.routes,
  boxoffice.routes,
  cabins.routes,
  status.routes,
  depot.routes,
  quotient.routes,
  bistro.routes,
  smarthome.routes,
  insure.routes,
  fernwood.routes,
  registrar.routes,
  telco.routes,
  utility.routes,
  jobs.routes,
  kiosk.routes,
];
