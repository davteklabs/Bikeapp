// Turn OSRM v5 maneuvers into human-readable instructions + an icon key.
// OSRM returns structured maneuvers (type/modifier) but no text, so we build it.

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

const MODIFIER_TEXT = {
  uturn: 'Make a U-turn',
  'sharp right': 'Turn sharp right',
  right: 'Turn right',
  'slight right': 'Bear right',
  straight: 'Continue straight',
  'slight left': 'Bear left',
  left: 'Turn left',
  'sharp left': 'Turn sharp left',
};

/** Arrow rotation in degrees for each modifier (0 = straight ahead). */
export const MODIFIER_ANGLE = {
  straight: 0,
  'slight right': 45,
  right: 90,
  'sharp right': 135,
  uturn: 180,
  'sharp left': -135,
  left: -90,
  'slight left': -45,
};

const onto = (name) => (name ? ` onto ${name}` : '');
const on = (name) => (name ? ` on ${name}` : '');

export function instructionText(step, { isLast = false } = {}) {
  const m = step.maneuver || {};
  const type = m.type;
  const mod = m.modifier;
  const name = step.name || step.ref || '';

  switch (type) {
    case 'depart': {
      const dir = compass(m.bearing_after);
      return `Head ${dir}${on(name)}`;
    }
    case 'arrive':
      if (mod === 'left' || mod === 'right') return `Arrive at your destination on the ${mod}`;
      return 'Arrive at your destination';
    case 'roundabout':
    case 'rotary': {
      const exit = m.exit && ORDINALS[m.exit] ? `the ${ORDINALS[m.exit]} exit` : 'the exit';
      return `At the roundabout, take ${exit}${onto(name)}`;
    }
    case 'roundabout turn':
      return `At the roundabout, ${(MODIFIER_TEXT[mod] || 'continue').toLowerCase()}${onto(name)}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto(name)}`;
    case 'fork':
      if (mod && mod.includes('left')) return `Keep left at the fork${onto(name)}`;
      if (mod && mod.includes('right')) return `Keep right at the fork${onto(name)}`;
      return `Continue at the fork${onto(name)}`;
    case 'merge':
      return `Merge${mod && mod.includes('left') ? ' left' : mod && mod.includes('right') ? ' right' : ''}${onto(name)}`;
    case 'end of road':
      return `At the end of the road, ${(MODIFIER_TEXT[mod] || 'turn').toLowerCase()}${onto(name)}`;
    case 'new name':
    case 'continue':
      if (!mod || mod === 'straight') return `Continue${onto(name) || ' straight'}`;
      if (mod === 'uturn') return `Make a U-turn${onto(name)}`;
      return `${MODIFIER_TEXT[mod] || 'Continue'}${onto(name)}`;
    case 'notification':
      return `Continue${on(name)}`;
    default: // turn, on ramp, off ramp, anything unknown
      if (isLast) return 'Arrive at your destination';
      return `${MODIFIER_TEXT[mod] || 'Continue'}${onto(name)}`;
  }
}

/** Icon descriptor: {kind: 'arrow'|'uturn'|'roundabout'|'arrive'|'depart', angle}. */
export function instructionIcon(step) {
  const m = step.maneuver || {};
  if (m.type === 'arrive') return { kind: 'arrive', angle: 0 };
  if (m.type === 'depart') return { kind: 'depart', angle: 0 };
  if (m.type === 'roundabout' || m.type === 'rotary' || m.type === 'roundabout turn')
    return { kind: 'roundabout', angle: 0, exit: m.exit };
  if (m.modifier === 'uturn') return { kind: 'uturn', angle: 0 };
  return { kind: 'arrow', angle: MODIFIER_ANGLE[m.modifier] ?? 0 };
}

function compass(b) {
  if (b == null) return 'out';
  const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return dirs[Math.round(b / 45) % 8];
}
