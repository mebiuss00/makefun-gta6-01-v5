// police.js — the Palmera Police Department. Heat from crimes turns into stars; stars
// decide how many cruisers and officers the city sends, how hard they chase, and whether
// they shoot. Stay unseen and the heat cools; get cornered at walking pace inside an
// officer's reach and the bust ring fills.

import {
  STAR_THRESHOLDS, HEAT_DECAY_HIDDEN, HEAT_DECAY_SEEN, SIGHT_RANGE, POLICE_CARS_BY_STAR,
  POLICE_FOOT_BY_STAR, POLICE_SHOOT_STARS, POLICE_CAR_TYPE, BUST_RADIUS, BUST_FILL_TIME, LAND_H,
  ROADBLOCK_STARS, ROADBLOCKS_BY_STAR, AIR_ONE_STARS, AIR_ONE_RANGE,
} from './config.js';
import { avenueCenterX, streetCenterY, collideWorld } from './city.js';
import { clamp, dist, randRange, angleDelta } from './random.js';
import { makeCar, stepCar, giveTrafficBrain } from './vehicles.js';
import { canSee, copShoot } from './combat.js';

export function starsForHeat(heat) {
  let stars = 0;
  for (let i = 1; i < STAR_THRESHOLDS.length; i++) {
    if (heat >= STAR_THRESHOLDS[i]) stars = i;
  }
  return stars;
}

// A point on a road, ringed around the player: where reinforcements arrive from.
function roadPointNear(g, minD, maxD) {
  const p = g.player;
  for (let tries = 0; tries < 10; tries++) {
    if (g.rng() < 0.5) {
      const i = Math.floor(g.rng() * 9);
      const x = avenueCenterX(i);
      const y = clamp(p.y + randRange(g.rng, -maxD, maxD), 40, LAND_H - 40);
      const d = dist(x, y, p.x, p.y);
      if (d >= minD && d <= maxD) return { x, y };
    } else {
      const j = Math.floor(g.rng() * 7);
      const y = streetCenterY(j);
      const x = clamp(p.x + randRange(g.rng, -maxD, maxD), 40, 3188);
      const d = dist(x, y, p.x, p.y);
      if (d >= minD && d <= maxD) return { x, y };
    }
  }
  return null;
}

// The named voice of the chase: PPD dispatch announces every escalation, and the
// stand-down when the suspect finally slips away. The HUD prefixes these with
// "PPD DISPATCH", so the stored text is the message itself.
const DISPATCH_LINES = [
  '',
  'All units, we have a report — one cruiser respond.',
  'Suspect is mobile. Cruisers converge, do not lose them.',
  'Roadblocks authorized. Seal the road ahead of the suspect.',
  'AIR ONE, you are cleared to launch. Keep the suspect in your searchlight.',
  'Citywide — every unit. Do not let that vehicle leave Palmera.',
];
const DISPATCH_STAND_DOWN = 'Suspect lost. All units stand down.';

function fireDispatch(g, text) {
  g.dispatch = { text, until: g.time + 4.6 };
}

function updateDispatch(g) {
  const stars = g.stars;
  if (stars > (g.announcedStars ?? 0)) {
    g.announcedStars = stars;
    if (DISPATCH_LINES[stars]) fireDispatch(g, DISPATCH_LINES[stars]);
  } else if (stars === 0 && (g.announcedStars ?? 0) > 0) {
    fireDispatch(g, DISPATCH_STAND_DOWN);
    g.announcedStars = 0;
  }
}

// --- roadblocks ---------------------------------------------------------------------------
// At three stars dispatch stops chasing from behind and seals the road ahead instead:
// two cruisers parked across the suspect's road, with a barricade between them.

function teardownRoadblock(g, rb) {
  for (const car of rb.cars) {
    if (car.driver === 'police' && car.roadblock) {
      car.driver = 'traffic';
      car.roadblock = false;
      giveTrafficBrain(car, g.rng);
    }
  }
}

function spawnRoadblock(g) {
  const p = g.player;
  // Aim ahead of the player along their heading; in a car, along the car's motion.
  let heading = p.angle;
  if (p.car) heading = p.car.speed < 0 ? p.car.angle + Math.PI : p.car.angle;
  const ahead = randRange(g.rng, 430, 520);
  const aimX = clamp(p.x + Math.cos(heading) * ahead, 40, 3188);
  const aimY = clamp(p.y + Math.sin(heading) * ahead, 40, LAND_H - 40);
  // Find the avenue and street nearest the aim point.
  let avX = avenueCenterX(0);
  let avD = Infinity;
  for (let i = 0; i <= 8; i++) {
    const d = Math.abs(avenueCenterX(i) - aimX);
    if (d < avD) { avD = d; avX = avenueCenterX(i); }
  }
  let stY = streetCenterY(0);
  let stD = Infinity;
  for (let j = 0; j <= 6; j++) {
    const d = Math.abs(streetCenterY(j) - aimY);
    if (d < stD) { stD = d; stY = streetCenterY(j); }
  }
  const mostlyVertical = Math.abs(Math.sin(heading)) > Math.abs(Math.cos(heading));
  let rb;
  if (avD <= stD || mostlyVertical) {
    rb = { x: avX, y: aimY, axis: 'avenue', cars: [] };
    for (const off of [-24, 24]) {
      const car = makeCar(POLICE_CAR_TYPE, avX + off, aimY, 0, POLICE_CAR_TYPE.colors[0]);
      car.driver = 'police';
      car.copOut = true;
      car.speed = 0;
      car.roadblock = true;
      car.postX = avX + off;
      car.postY = aimY;
      car.postAngle = 0;
      g.cars.push(car);
      rb.cars.push(car);
    }
  } else {
    rb = { x: aimX, y: stY, axis: 'street', cars: [] };
    for (const off of [-24, 24]) {
      const car = makeCar(POLICE_CAR_TYPE, aimX, stY + off, Math.PI / 2, POLICE_CAR_TYPE.colors[0]);
      car.driver = 'police';
      car.copOut = true;
      car.speed = 0;
      car.roadblock = true;
      car.postX = aimX;
      car.postY = stY + off;
      car.postAngle = Math.PI / 2;
      g.cars.push(car);
      rb.cars.push(car);
    }
  }
  g.roadblocks.push(rb);
}

export function updateRoadblocks(g, dt) {
  if (!g.roadblocks) g.roadblocks = [];
  const p = g.player;
  let heading = p.angle;
  if (p.car) heading = p.car.speed < 0 ? p.car.angle + Math.PI : p.car.angle;
  // Tear down blocks the chase has moved past, outgrown or left behind.
  for (let i = g.roadblocks.length - 1; i >= 0; i--) {
    const rb = g.roadblocks[i];
    const d = dist(rb.x, rb.y, p.x, p.y);
    const passed = (p.x - rb.x) * Math.cos(heading) + (p.y - rb.y) * Math.sin(heading);
    if (g.stars < ROADBLOCK_STARS || d > 760 || passed > 240) {
      teardownRoadblock(g, rb);
      g.roadblocks.splice(i, 1);
    }
  }
  const desired = g.stars >= ROADBLOCK_STARS ? ROADBLOCKS_BY_STAR[g.stars] : 0;
  if (g.roadblocks.length < desired && g.time >= (g.roadblockAt ?? 0)) {
    g.roadblockAt = g.time + 2.5;
    spawnRoadblock(g);
  }
}

// --- AIR ONE --------------------------------------------------------------------------------
// At four stars the helicopter joins: it orbits the suspect, and inside its searchlight
// range the player counts as watched, so the heat will not cool. It also talks the
// cruisers in closer (see spawnPoliceCar).

export function updateAirOne(g, dt) {
  const p = g.player;
  if (!g.heli && g.stars >= AIR_ONE_STARS) {
    const bearing = g.rng() * Math.PI * 2;
    g.heli = {
      x: p.x + Math.cos(bearing) * 700,
      y: p.y + Math.sin(bearing) * 700,
      angle: bearing + Math.PI,
      orbitA: bearing,
      leaving: false,
    };
  }
  const heli = g.heli;
  if (!heli) return;
  if (g.stars < AIR_ONE_STARS) heli.leaving = true;
  if (heli.leaving) {
    const away = Math.atan2(heli.y - p.y, heli.x - p.x);
    heli.angle = away;
    heli.x += Math.cos(away) * 430 * dt;
    heli.y += Math.sin(away) * 430 * dt;
    if (dist(heli.x, heli.y, p.x, p.y) > 850) g.heli = null;
    return;
  }
  heli.orbitA += dt * 0.35;
  const tx = p.x + Math.cos(heli.orbitA) * 130;
  const ty = p.y + Math.sin(heli.orbitA) * 130;
  const dx = tx - heli.x;
  const dy = ty - heli.y;
  const d = Math.hypot(dx, dy);
  if (d > 1) {
    const step = Math.min(d, 430 * dt);
    heli.x += (dx / d) * step;
    heli.y += (dy / d) * step;
    if (step > 0.5) heli.angle = Math.atan2(dy, dx);
  }
}

function spawnPoliceCar(g) {
  // With AIR ONE overhead, reinforcements are talked in closer than usual.
  const spot = g.heli ? roadPointNear(g, 360, 560) : roadPointNear(g, 540, 760);
  if (!spot) return;
  const car = makeCar(POLICE_CAR_TYPE, spot.x, spot.y, 0, POLICE_CAR_TYPE.colors[0]);
  car.driver = 'police';
  car.copOut = false;
  car.angle = Math.atan2(g.player.y - spot.y, g.player.x - spot.x);
  g.cars.push(car);
}

function spawnFootCop(g, x, y) {
  g.cops.push({
    x,
    y,
    angle: 0,
    speed: 0,
    hp: 100,
    state: 'chase', // chase | shoot | leave | dead
    stateT: 0,
    shootCd: randRange(g.rng, 0.3, 1.1),
    walkPhase: g.rng() * 6,
    shirt: '#22355c',
    pants: '#1b2432',
    skin: '#d9a06b',
    isCop: true,
    isTarget: false,
    muzzleT: 0,
    deadT: 0,
  });
}

export function updateWanted(g, dt) {
  const p = g.player;
  // Is any officer watching right now?
  let seen = false;
  for (const car of g.cars) {
    if (car.driver === 'police' && canSee(g.city, car.x, car.y, p.x, p.y, SIGHT_RANGE)) {
      seen = true;
      break;
    }
  }
  if (!seen) {
    for (const cop of g.cops) {
      if (cop.state !== 'dead' && canSee(g.city, cop.x, cop.y, p.x, p.y, SIGHT_RANGE)) {
        seen = true;
        break;
      }
    }
  }
  // AIR ONE's searchlight counts as being watched: the heat will not cool under it.
  if (!seen && g.heli && !g.heli.leaving && dist(g.heli.x, g.heli.y, p.x, p.y) < AIR_ONE_RANGE) {
    seen = true;
  }
  g.watched = seen;
  const decay = seen ? HEAT_DECAY_SEEN : HEAT_DECAY_HIDDEN;
  g.heat = Math.max(0, g.heat - decay * dt);
  g.stars = starsForHeat(g.heat);
}

// How fast the thing the player rides (or their own legs) is moving.
function playerSpeed(g) {
  if (g.player.car) return Math.abs(g.player.car.speed);
  return g.player.speedMag ?? 0;
}

export function updatePolice(g, dt) {
  const p = g.player;
  const stars = g.stars;

  updateDispatch(g);
  updateRoadblocks(g, dt);
  updateAirOne(g, dt);

  // --- keep the force at the strength the stars demand -------------------------------
  let carCount = 0;
  let footCount = 0;
  for (const car of g.cars) if (car.driver === 'police' && !car.roadblock) carCount++;
  for (const cop of g.cops) if (cop.state !== 'dead') footCount++;

  if (stars > 0) {
    if (carCount < POLICE_CARS_BY_STAR[stars]) spawnPoliceCar(g);
    if (footCount < POLICE_FOOT_BY_STAR[stars]) {
      // Officers step out of a cruiser that has arrived; if none is close, one runs in.
      let host = null;
      for (const car of g.cars) {
        if (car.driver === 'police' && !car.copOut && dist(car.x, car.y, p.x, p.y) < 210) {
          host = car;
          break;
        }
      }
      if (host) {
        host.copOut = true;
        spawnFootCop(g, host.x + 18, host.y + 10);
      } else if (footCount === 0 || carCount > 0) {
        const spot = roadPointNear(g, 400, 520);
        if (spot) spawnFootCop(g, spot.x, spot.y);
      }
    }
  } else {
    // No stars, no chase — whatever heat is left is paperwork. Cruisers peel off into
    // traffic and officers walk away, even if the heat has not fully cooled yet.
    for (const car of g.cars) {
      if (car.driver === 'police') {
        car.driver = 'traffic';
        car.copOut = false;
        car.roadblock = false;
        giveTrafficBrain(car, g.rng);
      }
    }
    g.roadblocks = [];
    for (let i = g.cops.length - 1; i >= 0; i--) {
      if (g.cops[i].state !== 'dead') g.cops.splice(i, 1);
    }
    g.bustProgress = 0;
  }

  // --- drive the cruisers --------------------------------------------------------------
  for (const car of g.cars) {
    if (car.driver !== 'police') continue;
    if (car.roadblock) {
      // A roadblock car holds its post; shoved off it, it creeps back and re-aligns.
      const postD = dist(car.x, car.y, car.postX, car.postY);
      if (postD <= 14) {
        car.angle += clamp(angleDelta(car.angle, car.postAngle), -2.4 * dt, 2.4 * dt);
        stepCar(car, { throttle: 0, steer: 0, brake: true }, dt, g.city);
      } else {
        const wantPost = Math.atan2(car.postY - car.y, car.postX - car.x);
        const steerPost = clamp(angleDelta(car.angle, wantPost) * 2.3, -1, 1);
        stepCar(car, { throttle: 0.35, steer: steerPost, brake: false }, dt, g.city);
      }
      continue;
    }
    if (dist(car.x, car.y, p.x, p.y) > 1200) {
      car.driver = 'traffic';
      giveTrafficBrain(car, g.rng);
      continue;
    }
    const target = p.car ?? p;
    // Aim a little ahead of a moving target.
    const lead = clamp(dist(car.x, car.y, target.x, target.y) / 300, 0, 0.7);
    let tx = target.x + Math.cos(target.angle ?? 0) * (target.speed ?? 0) * lead;
    let ty = target.y + Math.sin(target.angle ?? 0) * (target.speed ?? 0) * lead;
    // If a building blocks the way, aim for the target's road instead of the wall.
    if (!canSee(g.city, car.x, car.y, tx, ty, 99999)) {
      const av = Math.round((tx - 46) / 392);
      const st = Math.round((ty - 46) / 392);
      if (Math.abs(car.x - tx) > Math.abs(car.y - ty)) ty = streetCenterY(clamp(st, 0, 6));
      else tx = avenueCenterX(clamp(av, 0, 8));
    }
    const want = Math.atan2(ty - car.y, tx - car.x);
    const steer = clamp(angleDelta(car.angle, want) * 2.3, -1, 1);
    const d = dist(car.x, car.y, target.x, target.y);
    let throttle = 1;
    if (d < 55 && playerSpeed(g) < 40) throttle = 0.25; // arrive, don't flatten
    if (Math.abs(angleDelta(car.angle, want)) > 2.4 && d < 90) throttle = -0.7; // back out of a bad angle
    const impact = stepCar(car, { throttle, steer, brake: false }, dt, g.city);
    if (impact > 120) g.sound.crash(impact / 40);
  }

  // --- walk the officers -----------------------------------------------------------------
  let bustContact = false;
  for (let i = g.cops.length - 1; i >= 0; i--) {
    const cop = g.cops[i];
    if (cop.state === 'dead') {
      cop.deadT += dt;
      if (cop.deadT > 25) g.cops.splice(i, 1);
      continue;
    }
    cop.muzzleT = Math.max(0, (cop.muzzleT ?? 0) - dt);
    const d = dist(cop.x, cop.y, p.x, p.y);
    const seen = canSee(g.city, cop.x, cop.y, p.x, p.y, 330);
    let targetSpeed = 0;
    let want = cop.angle;

    if (stars >= POLICE_SHOOT_STARS && seen && d < 300 && d > 120 && !p.car) {
      // Hold a firing line: close enough to hit, far enough to stay standing.
      cop.state = 'shoot';
      want = Math.atan2(p.y - cop.y, p.x - cop.x);
      cop.shootCd -= dt;
      if (cop.shootCd <= 0) {
        cop.shootCd = randRange(g.rng, 0.7, 1.25);
        copShoot(g, cop, p);
      }
    } else {
      cop.state = 'chase';
      want = Math.atan2(p.y - cop.y, p.x - cop.x);
      targetSpeed = d > 26 ? 212 : 0;
      cop.shootCd = Math.max(cop.shootCd, 0.35);
    }
    cop.angle += clamp(angleDelta(cop.angle, want), -4.2 * dt, 4.2 * dt);
    cop.speed += (targetSpeed - cop.speed) * Math.min(1, dt * 7);
    cop.walkPhase += dt * (cop.speed > 10 ? cop.speed * 0.055 : 0);
    const nx = cop.x + Math.cos(cop.angle) * cop.speed * dt;
    const ny = cop.y + Math.sin(cop.angle) * cop.speed * dt;
    const fixed = collideWorld(g.city, nx, ny, 10);
    cop.x = fixed.x;
    cop.y = fixed.y;

    if (d < BUST_RADIUS && playerSpeed(g) < 55) bustContact = true;
  }

  // --- the bust ring ----------------------------------------------------------------------
  if (bustContact && stars > 0) {
    g.bustProgress = Math.min(1, g.bustProgress + dt / BUST_FILL_TIME);
    if (g.bustProgress >= 1) g.onPlayerBusted();
  } else {
    g.bustProgress = Math.max(0, g.bustProgress - dt * 1.8);
  }

  // Sirens belong to a chase that is actually close.
  let sirenNear = false;
  for (const car of g.cars) {
    if (car.driver === 'police' && dist(car.x, car.y, p.x, p.y) < 430) {
      sirenNear = true;
      break;
    }
  }
  g.sound.setSiren(sirenNear && stars > 0);
}
