/**
 * Missions: lightweight progression that gives a reason to keep running.
 *
 * Three missions are active at any time. Completing one awards coins and XP,
 * levels the player up, and immediately rolls a replacement, so there is always
 * a next goal. Progress is folded in once per run from the run's stat block
 * rather than being ticked live, which keeps the game loop free of this system
 * entirely.
 */

import { storage } from './engine/util.js';
import { STORAGE_KEYS } from './engine/constants.js';

/**
 * Mission templates.
 *
 * `stat` names a field on the run result (or its nested `stats`), `scale`
 * multiplies the base target as the player levels, and `reward` is in coins.
 */
const TEMPLATES = [
  { id: 'coins',      label: 'Collect {n} coins in one run',  stat: 'coins',       base: 60,   scale: 1.25, reward: 120 },
  { id: 'distance',   label: 'Run {n} m in one go',           stat: 'distance',    base: 700,  scale: 1.3,  reward: 150 },
  { id: 'score',      label: 'Score {n} points',              stat: 'score',       base: 4000, scale: 1.35, reward: 180 },
  { id: 'nearmiss',   label: 'Pull off {n} close calls',      stat: 'nearMisses',  base: 6,    scale: 1.3,  reward: 200 },
  { id: 'jumps',      label: 'Jump {n} times',                stat: 'jumps',       base: 25,   scale: 1.2,  reward: 90 },
  { id: 'slides',     label: 'Slide {n} times',               stat: 'slides',      base: 15,   scale: 1.2,  reward: 90 },
  { id: 'powerups',   label: 'Grab {n} power-ups',            stat: 'powerups',    base: 3,    scale: 1.25, reward: 160 },
  { id: 'combo',      label: 'Reach a {n} coin combo',        stat: 'bestCombo',   base: 20,   scale: 1.3,  reward: 170 },
  { id: 'roof',       label: 'Ride train roofs for {n}s',     stat: 'roofTime',    base: 6,    scale: 1.25, reward: 210 },
];

/** XP needed to reach the next level (grows steadily). */
export const xpForLevel = (level) => Math.round(500 * Math.pow(1.35, level - 1));

/** Roll a fresh mission, scaled to the player's level. */
function rollMission(level, excludeIds = []) {
  const pool = TEMPLATES.filter((t) => !excludeIds.includes(t.id));
  const template = (pool.length ? pool : TEMPLATES)[
    Math.floor(Math.random() * (pool.length ? pool.length : TEMPLATES.length))
  ];
  const target = Math.round(template.base * Math.pow(template.scale, Math.max(0, level - 1)));
  return {
    id: template.id,
    // Random suffix keeps React keys stable and unique across re-rolls.
    key: `${template.id}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    label: template.label.replace('{n}', target.toLocaleString('en-US')),
    stat: template.stat,
    target,
    progress: 0,
    reward: Math.round(template.reward * (1 + (level - 1) * 0.15)),
    done: false,
  };
}

/** Default progression blob. */
export function blankProgress() {
  const level = 1;
  const missions = [];
  while (missions.length < 3) {
    missions.push(rollMission(level, missions.map((m) => m.id)));
  }
  return {
    level,
    xp: 0,
    missions,
    lifetime: { runs: 0, coins: 0, distance: 0, nearMisses: 0, powerups: 0 },
  };
}

/** Load progression, repairing anything malformed. */
export function loadProgress(fromProfile) {
  const stored = (fromProfile && Object.keys(fromProfile).length)
    ? fromProfile
    : storage.get(STORAGE_KEYS.missions, null);

  if (!stored || !Array.isArray(stored.missions) || stored.missions.length === 0) {
    return blankProgress();
  }
  return {
    level: Number(stored.level) || 1,
    xp: Number(stored.xp) || 0,
    missions: stored.missions.slice(0, 3),
    lifetime: stored.lifetime || { runs: 0, coins: 0, distance: 0, nearMisses: 0, powerups: 0 },
  };
}

export function saveProgress(progress) {
  storage.set(STORAGE_KEYS.missions, progress);
}

/**
 * Fold a finished run into the progression state.
 *
 * @returns {{progress:object, completed:Array, coinsAwarded:number, leveledUp:boolean}}
 */
export function applyRun(progress, result) {
  const next = {
    ...progress,
    missions: progress.missions.map((m) => ({ ...m })),
    lifetime: { ...progress.lifetime },
  };

  // Flatten the run result so `stat` can address either level.
  const values = {
    score: result.score,
    coins: result.coins,
    distance: result.distance,
    bestCombo: result.bestCombo,
    ...result.stats,
  };

  next.lifetime.runs += 1;
  next.lifetime.coins += result.coins;
  next.lifetime.distance += result.distance;
  next.lifetime.nearMisses += result.stats.nearMisses || 0;
  next.lifetime.powerups += result.stats.powerups || 0;

  const completed = [];
  let coinsAwarded = 0;
  let xpGained = Math.floor(result.score / 100);

  for (const mission of next.missions) {
    if (mission.done) continue;
    const value = Number(values[mission.stat]) || 0;
    // Missions measure a single run's best, not a running total, so a mission
    // is met when one run clears the bar.
    mission.progress = Math.max(mission.progress, value);
    if (mission.progress >= mission.target) {
      mission.done = true;
      completed.push(mission);
      coinsAwarded += mission.reward;
      xpGained += Math.round(mission.reward / 2);
    }
  }

  next.xp += xpGained;
  let leveledUp = false;
  while (next.xp >= xpForLevel(next.level)) {
    next.xp -= xpForLevel(next.level);
    next.level += 1;
    leveledUp = true;
  }

  // Replace completed missions with fresh ones at the new level.
  next.missions = next.missions.map((mission) =>
    mission.done ? rollMission(next.level, next.missions.map((m) => m.id)) : mission,
  );

  saveProgress(next);
  return { progress: next, completed, coinsAwarded, leveledUp };
}
