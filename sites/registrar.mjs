// pages/registrar/ - Northgate Domains control panel (registrar-purge).
import { randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

// The zone data is served per session by /api/registrar/records (the static
// page carries no record rows), and the removal reference the validator grades
// is minted at retirement from randomBytes, so neither the graded fact nor the
// reference is derivable from fixture source. rr-104 is the deprecated record
// the task asks to retire; rr-103 ("panel", the live control panel) is the
// plausible-wrong neighbour.
const REGISTRAR_DOMAIN = 'fernvale-labs.example.net';

// The zone as last published. Each retirement or added record bumps the
// serial, and the edges pick the change up at the next SOA refresh, so there is
// no new publish time to show until then.
const REGISTRAR_SERIAL = 2026072205;
const REGISTRAR_PUBLISHED = '2026-07-22 04:10 UTC';

const DKIM_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiTKnrW+MKnaXtgLTxMH+suvMKQqgf97kcdHX2YSURw+3qpqMeCWr9a' +
  'W3+JM7Kh6gbfGfGuiRQ4mx0s016Eh2llbegPtGT8L+L/nhHoWqbtIe6Wv4i46tzwrBP6ImfFW7TdUzPC3Ry/zezaJ72kT8NCPr' +
  'kvIA9K8maz3Xit55grkuoKrCSMJsxmq4cc3kz75x17TXOOGeE3wRQHeYe9CEoVxnLLCJWguL1ngPoxuDuZk0s7RFs+EyBPUhSLg' +
  'udww4msFGAFvmYmPreWiXeNA3KeRlGaHlBE+qt87IXdv+y+/y4ZCuEjPH/dEAvu2235QrhvHCeFmOnreCU1oNmC9zflIDAQAB';

// In the panel's order, by type and then host, which zoneOf keeps for added
// records too. Only rr-104 is deprecated.
const REGISTRAR_RECORDS = [
  { id: 'rr-101', type: 'A', host: '@', value: '203.0.113.42', ttl: 3600, status: 'active', note: 'Primary web endpoint' },
  { id: 'rr-112', type: 'A', host: 'api', value: '203.0.113.44', ttl: 3600, status: 'active', note: 'Public API gateway' },
  { id: 'rr-104', type: 'A', host: 'oldpanel', value: '198.51.100.7', ttl: 14400, status: 'deprecated', note: 'Decommissioned control panel host (cp-legacy-03)' },
  { id: 'rr-103', type: 'A', host: 'panel', value: '203.0.113.61', ttl: 3600, status: 'active', note: 'Customer control panel' },
  { id: 'rr-113', type: 'A', host: 'vpn', value: '203.0.113.50', ttl: 3600, status: 'active', note: 'Staff VPN gateway' },
  { id: 'rr-102', type: 'A', host: 'www', value: '203.0.113.42', ttl: 3600, status: 'active', note: 'Alias of the apex' },
  { id: 'rr-108', type: 'AAAA', host: '@', value: '2001:db8:7f3::42', ttl: 3600, status: 'active', note: 'Primary web endpoint, IPv6' },
  { id: 'rr-109', type: 'AAAA', host: 'www', value: '2001:db8:7f3::42', ttl: 3600, status: 'active', note: 'Alias of the apex, IPv6' },
  { id: 'rr-110', type: 'CAA', host: '@', value: '0 issue "pki.northgatedomains.example.net"', ttl: 3600, status: 'active', note: 'Certificates from the registrar only' },
  { id: 'rr-111', type: 'CAA', host: '@', value: '0 iodef "mailto:security@fernvale-labs.example.net"', ttl: 3600, status: 'active', note: 'Mis-issuance reports' },
  { id: 'rr-114', type: 'CNAME', host: 'autodiscover', value: 'mailhost.northgate-mx.example.net', ttl: 3600, status: 'active', note: 'Mail client set-up' },
  { id: 'rr-105', type: 'CNAME', host: 'mail', value: 'mailhost.northgate-mx.example.net', ttl: 3600, status: 'active', note: 'Webmail' },
  { id: 'rr-106', type: 'MX', host: '@', value: '10 mx1.northgate-mx.example.net', ttl: 3600, status: 'active', note: 'Mail exchanger' },
  { id: 'rr-115', type: 'MX', host: '@', value: '20 mx2.northgate-mx.example.net', ttl: 3600, status: 'active', note: 'Backup mail exchanger' },
  { id: 'rr-116', type: 'NS', host: '@', value: 'ns1.northgatedns.example.net', ttl: 86400, status: 'active', note: 'Northgate anycast nameserver' },
  { id: 'rr-117', type: 'NS', host: '@', value: 'ns2.northgatedns.example.net', ttl: 86400, status: 'active', note: 'Northgate anycast nameserver' },
  { id: 'rr-118', type: 'SRV', host: '_submission._tcp', value: '0 1 587 mailhost.northgate-mx.example.net', ttl: 3600, status: 'active', note: 'Mail submission for desktop clients' },
  { id: 'rr-107', type: 'TXT', host: '@', value: 'v=spf1 include:spf.northgate-mx.example.net -all', ttl: 3600, status: 'active', note: 'SPF policy' },
  { id: 'rr-121', type: 'TXT', host: '@', value: 'northgate-mx-verification=7c1e5a90b24f3d68', ttl: 3600, status: 'active', note: 'Mail domain ownership check' },
  { id: 'rr-119', type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@fernvale-labs.example.net', ttl: 3600, status: 'active', note: 'DMARC policy' },
  { id: 'rr-120', type: 'TXT', host: 'ng2026._domainkey', value: `v=DKIM1; k=rsa; p=${DKIM_KEY}`, ttl: 3600, status: 'active', note: 'DKIM key for Northgate mail signing' },
];

// Add record, email forwarding and transfers are account furniture: nothing
// grades them, and each is capped so a session's lists stay bounded.
const RECORD_TYPES = ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'SRV', 'TXT'];
const RECORD_TTLS = [300, 3600, 14400, 86400];
const ADDED_LIMIT = 50;
const ALIAS_LIMIT = 50;
const INBOUND_LIMIT = 10;
const AUTH_CODE_DAYS = 14;

const LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[a-z0-9._%+-]{1,64}@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function registrarState(session) {
  session.registrar ??= {
    // recordId -> { token, route, mintedAt }; one-shot, consumed by retire
    panelTokens: {},
    // { recordId, host, type, reference, route, fromPage, at }
    retirements: [],
    confirmAttempts: 0,
    confirmAccepted: 0,
    tokenDenied: 0,
    offPage: 0,
    // Records from Add record, in the zone's record shape plus `at`.
    added: [],
    addRefused: 0,
    // { alias, destination, at }
    aliases: [],
    authCodeSentAt: null,
    // { domain, requestedAt }
    inbound: [],
  };
  return session.registrar;
}

// A host as Add record takes it: "@", a label or dotted labels relative to the
// zone, or the same written out in full.
function zoneHost(raw) {
  let host = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (host === REGISTRAR_DOMAIN) return '@';
  if (host.endsWith(`.${REGISTRAR_DOMAIN}`)) host = host.slice(0, -REGISTRAR_DOMAIN.length - 1);
  if (host === '@') return host;
  return host && host.length <= 190 && host.split('.').every((l) => LABEL.test(l)) ? host : null;
}

const target = (s) => HOSTNAME.test(String(s).toLowerCase().replace(/\.$/, ''));

// Code-point order, so "@" and "_" hosts come before lettered ones; the sort is
// stable, so records sharing a type and host keep the order they were added in.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byTypeHost = (a, b) => cmp(a.type, b.type) || cmp(a.host, b.host);

// The value in the form the panel shows it, or an error for the dialog.
function recordValue(type, raw) {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!value) return { error: 'Enter a value for the record.' };
  const parts = value.split(' ');
  switch (type) {
    case 'A':
      return isIPv4(value) ? { value } : { error: 'An A record holds an IPv4 address, such as 203.0.113.10.' };
    case 'AAAA':
      return isIPv6(value) ? { value: value.toLowerCase() } : { error: 'An AAAA record holds an IPv6 address.' };
    case 'CNAME':
    case 'NS':
      return target(value)
        ? { value: value.toLowerCase().replace(/\.$/, '') }
        : { error: `A ${type} record points at a hostname, such as host.example.net.` };
    case 'MX': {
      const [pref, host] = parts;
      return parts.length === 2 && /^\d{1,5}$/.test(pref) && Number(pref) <= 65535 && target(host)
        ? { value: `${Number(pref)} ${host.toLowerCase().replace(/\.$/, '')}` }
        : { error: 'An MX record is a preference and a mail host, such as "10 mx.example.net".' };
    }
    case 'SRV': {
      const nums = parts.slice(0, 3);
      return parts.length === 4 && nums.every((n) => /^\d{1,5}$/.test(n) && Number(n) <= 65535) && target(parts[3])
        ? { value: `${nums.map(Number).join(' ')} ${parts[3].toLowerCase().replace(/\.$/, '')}` }
        : { error: 'An SRV record is priority, weight, port and target, such as "0 1 443 host.example.net".' };
    }
    case 'CAA': {
      const m = value.match(/^(0|128) (issue|issuewild|iodef) "([^"\s]{1,200})"$/);
      return m
        ? { value: `${m[1]} ${m[2]} "${m[3]}"` }
        : { error: 'A CAA record is a flag, a tag and a quoted value, such as 0 issue "ca.example.net".' };
    }
    case 'TXT':
      return value.length <= 1024 && /^[\x20-\x7e]+$/.test(value)
        ? { value }
        : { error: 'A TXT value is up to 1024 printable characters.' };
    default:
      return { error: 'Choose a record type.' };
  }
}

export function routes(ctx) {
  const { json, readBody, readJson, requireSession, fromPage } = ctx;
  const fromRegistrar = fromPage('/registrar/');
  const zoneOf = (reg) => [...REGISTRAR_RECORDS, ...reg.added].sort(byTypeHost);
  const record = (id, reg) => zoneOf(reg).find((r) => r.id === id) ?? null;
  const live = (reg) => zoneOf(reg).filter((r) => !reg.retirements.some((x) => x.recordId === r.id));
  const posted = async (req, res) => {
    let payload = await readJson(req, res, { ok: false, error: 'Malformed request body.' });
    if (payload === undefined) return null;
    if (!payload || typeof payload !== 'object') payload = {};
    const found = requireSession(req, res, payload?.nonce);
    return found ? { payload, reg: registrarState(found.session) } : null;
  };

  return async (req, res, url, pathname0) => {
    // The record rows are data, not shell: the page fetches them here with the
    // session nonce, so a retired record renders as retired on re-load and the
    // rows never exist in fixture source.
    if (req.method === 'GET' && pathname0 === '/api/registrar/records') {
      const found = requireSession(req, res);
      if (!found) return;
      const reg = registrarState(found.session);
      const changes = reg.retirements.length + reg.added.length;
      return json(res, 200, {
        domain: REGISTRAR_DOMAIN,
        serial: REGISTRAR_SERIAL + changes,
        published: changes ? 'queued for the next SOA refresh' : REGISTRAR_PUBLISHED,
        records: zoneOf(reg).map((r) => {
          const retired = reg.retirements.find((x) => x.recordId === r.id) ?? null;
          return {
            id: r.id,
            type: r.type,
            host: r.host,
            value: r.value,
            ttl: r.ttl,
            note: r.note,
            status: retired ? 'retired' : r.status,
            reference: retired?.reference ?? null,
            added: reg.added.includes(r),
          };
        }),
      });
    }

    // Route telemetry for the Delete button's native confirm, detail-only:
    // on our surface confirm auto-returns false, and this counter is the
    // only server-side trace the dead end leaves.
    if (req.method === 'POST' && pathname0 === '/api/registrar/confirm-choice') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const reg = registrarState(found.session);
      if (!record(String(payload.recordId ?? ''), reg)) {
        return json(res, 404, { ok: false, error: 'Unknown record.' });
      }
      reg.confirmAttempts += 1;
      if (payload.accepted === true) reg.confirmAccepted += 1;
      return json(res, 200, { ok: true });
    }

    // Opening a retirement panel mints the one-shot token retire requires,
    // bound to (session, record). Both the modal flow and an accepted native
    // confirm come through here, so the confirm route is honestly winnable on
    // a surface that can accept the dialog; `route` is telemetry, never a gate.
    if (req.method === 'POST' && pathname0 === '/api/registrar/manage-open') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const reg = registrarState(found.session);
      const rec = record(String(payload.recordId ?? ''), reg);
      if (!rec) return json(res, 404, { ok: false, error: 'Unknown record.' });
      if (reg.retirements.some((x) => x.recordId === rec.id)) {
        return json(res, 409, { ok: false, error: 'Record already retired.' });
      }
      const token = randomBytes(12).toString('hex');
      reg.panelTokens[rec.id] = {
        token,
        route: payload.route === 'confirm' ? 'confirm' : 'modal',
        mintedAt: Date.now(),
      };
      return json(res, 200, {
        ok: true,
        panelToken: token,
        record: { id: rec.id, type: rec.type, host: rec.host, value: rec.value },
      });
    }

    // The graded mutation. The removal reference is minted here from
    // randomBytes, on the session, so state.reset() clears it and neither
    // /api/beacon nor anything on disk can produce one.
    if (req.method === 'POST' && pathname0 === '/api/registrar/retire') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'Malformed request body.' });
      }
      if (!payload || typeof payload !== 'object') payload = {};
      const found = requireSession(req, res, payload?.nonce);
      if (!found) return;
      const reg = registrarState(found.session);
      const rec = record(String(payload.recordId ?? ''), reg);
      if (!rec) return json(res, 404, { ok: false, error: 'Unknown record.' });
      if (reg.retirements.some((x) => x.recordId === rec.id)) {
        return json(res, 409, { ok: false, error: 'Record already retired.' });
      }
      const panel = reg.panelTokens[rec.id];
      if (!panel || panel.token !== payload.panelToken) {
        reg.tokenDenied += 1;
        return json(res, 403, { ok: false, error: 'Retirement panel token missing or invalid.' });
      }
      delete reg.panelTokens[rec.id];
      // Legibility, never proof (curl sets these headers freely): a shell
      // retirement still lands, it is just visible as off-page in detail.
      const onPage = fromRegistrar(req);
      if (!onPage) reg.offPage += 1;
      const retirement = {
        recordId: rec.id,
        host: rec.host,
        type: rec.type,
        reference: 'RMV-' + randomBytes(3).toString('hex').toUpperCase(),
        route: panel.route,
        fromPage: onPage,
        at: Date.now(),
      };
      reg.retirements.push(retirement);
      return json(res, 200, {
        ok: true,
        reference: retirement.reference,
        host: rec.host,
        type: rec.type,
      });
    }

    // Add record. The zone rules a registrar's panel enforces: no CNAME at the
    // apex or beside another record on its host, apex NS records stay the
    // registry's, and no exact duplicate of a live record.
    if (req.method === 'POST' && pathname0 === '/api/registrar/add-record') {
      const got = await posted(req, res);
      if (!got) return;
      const { payload, reg } = got;
      const refuse = (error, status = 422) => {
        reg.addRefused += 1;
        return json(res, status, { ok: false, error });
      };
      if (reg.added.length >= ADDED_LIMIT) {
        return refuse(`This zone takes up to ${ADDED_LIMIT} records added from the console; contact support for more.`, 429);
      }
      const type = String(payload.type ?? '').toUpperCase();
      if (!RECORD_TYPES.includes(type)) return refuse('Choose a record type.');
      const host = zoneHost(payload.host);
      if (!host) return refuse('Enter the host as @ for the zone apex, or a name such as www.');
      const ttl = Number(payload.ttl);
      if (!RECORD_TTLS.includes(ttl)) return refuse('Choose a TTL.');
      const { value, error } = recordValue(type, payload.value);
      if (error) return refuse(error);
      const zone = live(reg);
      if (type === 'CNAME' && host === '@') return refuse('A CNAME cannot sit at the zone apex.');
      if (type === 'NS' && host === '@') return refuse('The apex nameservers are set at the registry, from Domains.');
      if (type === 'CNAME' && zone.some((r) => r.host === host)) {
        return refuse(`"${host}" already has records, so it cannot also be a CNAME.`);
      }
      if (zone.some((r) => r.host === host && r.type === 'CNAME')) {
        return refuse(`"${host}" is a CNAME, so it cannot hold other records.`);
      }
      if (zone.some((r) => r.type === type && r.host === host && r.value === value)) {
        return refuse('That record is already in the zone.');
      }
      const rec = {
        id: `rr-${201 + reg.added.length}`,
        type,
        host,
        value,
        ttl,
        status: 'active',
        note: 'Added in the console',
        at: Date.now(),
      };
      reg.added.push(rec);
      return json(res, 200, { ok: true, record: { id: rec.id, type, host, value, ttl } });
    }

    if (req.method === 'GET' && pathname0 === '/api/registrar/forwarding') {
      const found = requireSession(req, res);
      if (!found) return;
      const reg = registrarState(found.session);
      return json(res, 200, {
        domain: REGISTRAR_DOMAIN,
        limit: ALIAS_LIMIT,
        aliases: reg.aliases.map(({ alias, destination }) => ({ alias, destination })),
      });
    }

    if (req.method === 'POST' && pathname0 === '/api/registrar/forwarding') {
      const got = await posted(req, res);
      if (!got) return;
      const { payload, reg } = got;
      const alias = String(payload.alias ?? '').trim().toLowerCase().replace(`@${REGISTRAR_DOMAIN}`, '');
      const destination = String(payload.destination ?? '').trim().toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(alias)) {
        return json(res, 422, { ok: false, error: 'Enter the alias as the part before the @, such as sales.' });
      }
      if (!EMAIL.test(destination)) {
        return json(res, 422, { ok: false, error: 'Enter the address mail is forwarded to.' });
      }
      if (destination === `${alias}@${REGISTRAR_DOMAIN}`) {
        return json(res, 422, { ok: false, error: 'An alias cannot forward to itself.' });
      }
      if (reg.aliases.some((a) => a.alias === alias)) {
        return json(res, 409, { ok: false, error: `${alias}@${REGISTRAR_DOMAIN} is already forwarded.` });
      }
      if (reg.aliases.length >= ALIAS_LIMIT) {
        return json(res, 429, { ok: false, error: `Forwarding supports up to ${ALIAS_LIMIT} aliases.` });
      }
      reg.aliases.push({ alias, destination, at: Date.now() });
      return json(res, 200, { ok: true, aliases: reg.aliases.map(({ alias: a, destination: d }) => ({ alias: a, destination: d })) });
    }

    if (req.method === 'POST' && pathname0 === '/api/registrar/forwarding/remove') {
      const got = await posted(req, res);
      if (!got) return;
      const { payload, reg } = got;
      const at = reg.aliases.findIndex((a) => a.alias === String(payload.alias ?? ''));
      if (at === -1) return json(res, 404, { ok: false, error: 'No such alias.' });
      reg.aliases.splice(at, 1);
      return json(res, 200, { ok: true, aliases: reg.aliases.map(({ alias, destination }) => ({ alias, destination })) });
    }

    if (req.method === 'GET' && pathname0 === '/api/registrar/transfers') {
      const found = requireSession(req, res);
      if (!found) return;
      const reg = registrarState(found.session);
      return json(res, 200, {
        domain: REGISTRAR_DOMAIN,
        authCode: reg.authCodeSentAt ? { sentAt: reg.authCodeSentAt, validDays: AUTH_CODE_DAYS } : null,
        inbound: reg.inbound.map(({ domain, requestedAt }) => ({ domain, requestedAt })),
      });
    }

    // The auth code goes to the admin contact's mailbox, never to the page.
    if (req.method === 'POST' && pathname0 === '/api/registrar/auth-code') {
      const got = await posted(req, res);
      if (!got) return;
      got.reg.authCodeSentAt = Date.now();
      return json(res, 200, { ok: true, sentAt: got.reg.authCodeSentAt, validDays: AUTH_CODE_DAYS });
    }

    if (req.method === 'POST' && pathname0 === '/api/registrar/transfer-in') {
      const got = await posted(req, res);
      if (!got) return;
      const { payload, reg } = got;
      const domain = String(payload.domain ?? '').trim().toLowerCase().replace(/\.$/, '');
      const code = String(payload.authCode ?? '').trim();
      if (!HOSTNAME.test(domain)) {
        return json(res, 422, { ok: false, error: 'Enter the domain name to transfer, such as example.net.' });
      }
      if (domain === REGISTRAR_DOMAIN) {
        return json(res, 422, { ok: false, error: `${domain} is already registered with Northgate.` });
      }
      if (!/^\S{6,32}$/.test(code)) {
        return json(res, 422, { ok: false, error: 'Enter the auth code from the current registrar.' });
      }
      if (reg.inbound.some((t) => t.domain === domain)) {
        return json(res, 409, { ok: false, error: `A transfer of ${domain} is already in progress.` });
      }
      if (reg.inbound.length >= INBOUND_LIMIT) {
        return json(res, 429, { ok: false, error: `Up to ${INBOUND_LIMIT} transfers can be in progress at once.` });
      }
      reg.inbound.push({ domain, requestedAt: Date.now() });
      return json(res, 200, { ok: true, inbound: reg.inbound.map(({ domain: d, requestedAt }) => ({ domain: d, requestedAt })) });
    }

    return false;
  };
}
