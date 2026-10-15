import { ahkString } from './filesystem.js';

function clickAt(action, coordMode) {
  return [
    `CoordMode("Mouse", ${ahkString(coordMode)})`,
    `Click(${action.x}, ${action.y}, ${ahkString(action.button)}, ${action.clicks})`,
  ];
}

/** AutoHotkey v2 statements for one normalized click. */
export function clickBody(action) {
  if (action.mode === 'coord') return clickAt(action, 'Screen').join('\n');

  if (action.mode === 'title') {
    const title = ahkString(action.title);
    const lines = [
      `if !WinExist(${title})`,
      '    throw Error("window not found")',
      `WinActivate(${title})`,
      `if !WinWaitActive(${title}, , 2)`,
      '    throw Error("window not active")',
    ];
    if (Number.isInteger(action.x) && Number.isInteger(action.y)) lines.push(...clickAt(action, 'Window'));
    return lines.join('\n');
  }

  if (action.mode === 'control') {
    return [
      `if !ControlClick(${ahkString(action.control)}, ${ahkString(action.title)}, , ${ahkString(action.button)}, ${action.clicks})`,
      '    throw Error("control click failed")',
    ].join('\n');
  }

  if (action.mode === 'image') {
    return [
      'CoordMode("Pixel", "Screen")',
      'CoordMode("Mouse", "Screen")',
      `if !ImageSearch(&foundX, &foundY, 0, 0, A_ScreenWidth, A_ScreenHeight, ${ahkString(`*50 ${action.image}`)})`,
      '    throw Error("image not found")',
      `Click(foundX, foundY, ${ahkString(action.button)}, ${action.clicks})`,
    ].join('\n');
  }

  throw new Error(`unknown click mode: ${action.mode}`);
}
