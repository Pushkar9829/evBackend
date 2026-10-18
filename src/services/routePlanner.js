// Route planner with charging stops (Phase 2). Geometry comes from an OSRM-compatible router when
// ROUTING_URL is set (e.g. https://router.project-osrm.org), else a great-circle line with a road factor.
import { Charger, Site, Tenant } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { activeTariff } from './tariffs.js';
import { isOnline } from '../ocpp/commands.js';

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

const ROAD_FACTOR = 1.25; // straight-line to road distance in Indian conditions (approximation)

/** Polyline points [{lat,lng}] and cumulative road km at each point. */
async function geometry(from, to) {
  const url = process.env.ROUTING_URL;
  if (url) {
    try {
      const r = await fetch(`${url.replace(/\/$/, '')}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=simplified&geometries=geojson`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const coords = j.routes?.[0]?.geometry?.coordinates;
      if (coords?.length > 1) {
        const pts = coords.map(([lng, lat]) => ({ lat, lng }));
        const scale = j.routes[0].distance / 1000 / pts.slice(1).reduce((s, p, i) => s + haversineKm(pts[i], p), 0);
        return { pts, scale, source: 'osrm', durationMin: Math.round(j.routes[0].duration / 60) };
      }
    } catch (e) {
      logger.warn(`routing service failed, using straight line: ${e.message}`);
    }
  }
  const n = Math.max(2, Math.ceil(haversineKm(from, to) / 5));
  const pts = Array.from({ length: n + 1 }, (_, i) => ({ lat: from.lat + ((to.lat - from.lat) * i) / n, lng: from.lng + ((to.lng - from.lng) * i) / n }));
  return { pts, scale: ROAD_FACTOR, source: 'straight_line' };
}

/** Distance of point p from the polyline, and the road-km position of its closest point. */
function project(p, pts, cum) {
  let best = { off: Infinity, at: 0 };
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    // planar projection is fine at these distances
    const kx = Math.cos(rad(a.lat)) * 111;
    const ax = a.lng * kx; const ay = a.lat * 111; const bx = b.lng * kx; const by = b.lat * 111; const px = p.lng * kx; const py = p.lat * 111;
    const dx = bx - ax; const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (off < best.off) best = { off, at: cum[i] + t * (cum[i + 1] - cum[i]) };
  }
  return best;
}

/**
 * Greedy plan: drive until the charge would drop below the reserve, stop at the farthest
 * reachable working charger on the corridor, charge to `chargeToPct`, repeat.
 */
export async function planRoute({ from, to, rangeKm, socPct = 80, reservePct = 15, chargeToPct = 80, batteryKwh = 40, corridorKm = 8, connectorTypes, vehicleType }) {
  const g = await geometry(from, to);
  const cum = [0];
  for (let i = 1; i < g.pts.length; i += 1) cum.push(cum[i - 1] + haversineKm(g.pts[i - 1], g.pts[i]) * g.scale);
  const totalKm = cum[cum.length - 1];

  const tenants = (await Tenant.find({ status: 'active' }).select('_id').lean()).map((t) => t._id);
  const chargers = await Charger.find({ deletedAt: null, readyForPublic: true, inService: true, tenant: { $in: tenants } }).lean();
  const sites = new Map((await Site.find({ _id: { $in: chargers.map((c) => c.site) } }).lean()).map((s) => [String(s._id), s]));
  const candidates = [];
  for (const c of chargers) {
    const s = sites.get(String(c.site));
    if (!s?.location?.lat) continue;
    const conns = c.connectors.filter((x) => (!connectorTypes?.length || connectorTypes.includes(x.type)) && (!vehicleType || (x.vehicleTypes || []).includes(vehicleType)));
    if (!conns.length) continue;
    const pr = project(s.location, g.pts, cum);
    if (pr.off > corridorKm) continue;
    const working = c.online && isOnline(c.ocppId) && conns.some((x) => ['Available', 'Occupied'].includes(x.status));
    candidates.push({ charger: c, site: s, atKm: pr.at, detourKm: Math.round(pr.off * 2 * 10) / 10, maxPowerKw: Math.max(...conns.map((x) => x.maxPowerKw)), working, available: conns.some((x) => x.status === 'Available' && !x.activeSession) });
  }
  candidates.sort((a, b) => a.atKm - b.atKm);
  const usable = candidates.filter((c) => c.working);

  const kmPerPct = rangeKm / 100;
  let pos = 0;
  let soc = socPct;
  const stops = [];
  let feasible = true;
  for (let guard = 0; guard < 20; guard += 1) {
    const reach = pos + (soc - reservePct) * kmPerPct;
    if (reach >= totalKm) break;
    const options = usable.filter((c) => c.atKm > pos + 1 && c.atKm <= reach);
    if (!options.length) {
      feasible = false;
      break;
    }
    // Prefer the farthest stop; among the last 20 km of reach, prefer faster/available chargers.
    const far = options[options.length - 1].atKm;
    const near = options.filter((c) => c.atKm >= far - 20).sort((a, b) => (b.available - a.available) || (b.maxPowerKw - a.maxPowerKw) || (b.atKm - a.atKm));
    const pick = near[0];
    const arriveSoc = Math.round(soc - (pick.atKm - pos + pick.detourKm / 2) / kmPerPct);
    const addPct = Math.max(0, chargeToPct - arriveSoc);
    const kwhNeeded = (addPct / 100) * batteryKwh;
    const tariff = await activeTariff(pick.charger.tenant, pick.charger.tariffKey);
    stops.push({
      ocppId: pick.charger.ocppId,
      label: pick.charger.label,
      site: { name: pick.site.name, address: pick.site.address, location: pick.site.location },
      atKm: Math.round(pick.atKm),
      detourKm: pick.detourKm,
      arriveSocPct: arriveSoc,
      leaveSocPct: chargeToPct,
      kwh: Math.round(kwhNeeded * 10) / 10,
      minutes: Math.round((kwhNeeded / Math.max(1, Math.min(pick.maxPowerKw, batteryKwh * 2))) * 60 * 1.1),
      estCostPaise: tariff ? Math.round((kwhNeeded * tariff.energyPaisePerKwh + (tariff.sessionFeePaise || 0)) * 1.18) : null,
      maxPowerKw: pick.maxPowerKw,
      availableNow: pick.available,
    });
    pos = pick.atKm;
    soc = chargeToPct;
  }
  const arriveSoc = feasible ? Math.round(soc - (totalKm - pos) / kmPerPct) : null;
  const waypoints = stops.map((s) => `${s.site.location.lat},${s.site.location.lng}`).join('|');
  return {
    totalKm: Math.round(totalKm),
    routeSource: g.source,
    driveMin: g.durationMin || Math.round((totalKm / 45) * 60),
    feasible,
    message: feasible ? (stops.length ? `${stops.length} charging stop(s) needed.` : 'You can make it without charging.') : 'No working charger within range on this route. Charge more before leaving or choose another route.',
    arriveSocPct: arriveSoc,
    stops,
    chargersOnRoute: candidates.map((c) => ({ ocppId: c.charger.ocppId, site: c.site.name, atKm: Math.round(c.atKm), working: c.working, location: c.site.location })),
    path: g.pts.filter((_, i) => i % Math.ceil(g.pts.length / 60) === 0 || i === g.pts.length - 1),
    navigationUrl: `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}${waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : ''}&travelmode=driving`,
  };
}
