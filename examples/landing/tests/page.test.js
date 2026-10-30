import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
const script = read('src/main.js');
const styles = read('src/styles.scss');

function openingTag(tag, selector) {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))]
    .map(([match]) => match)
    .find((match) => selector.test(match));
}

function attribute(tag, name) {
  return tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

test('menu has an accessible trigger, a unique target, and starts closed', () => {
  const button = openingTag('button', /class="menu-trigger"/);
  const nav = openingTag('nav', /id="site-menu"/);
  assert.ok(button);
  assert.ok(nav);
  assert.equal(attribute(button, 'type'), 'button');
  assert.equal(attribute(button, 'aria-label'), 'Menu');
  assert.equal(attribute(button, 'aria-controls'), 'site-menu');
  assert.equal(attribute(button, 'aria-expanded'), 'false');
  assert.match(nav, /\shidden(?:\s|>)/);
  assert.ok(attribute(nav, 'aria-label'));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'IDs must be unique');
  assert.equal(ids.filter((id) => id === 'site-menu').length, 1);
});

test('navigation targets exist and page modules agree on selectors', () => {
  const menuContents = html.match(/<nav\b[^>]*id="site-menu"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(menuContents);
  const targets = [...menuContents.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(targets, ['home', 'services', 'contact']);
  for (const id of targets) assert.match(html, new RegExp(`\\bid="${id}"`));
  assert.match(html, /<script\s+type="module"\s+src="\/src\/main\.js"/);
  assert.match(script, /import\s+['"]\.\/styles\.scss['"]/);
  for (const selector of ['menu-trigger', 'site-menu', 'icon', 'is-loaded']) {
    assert.ok(script.includes(selector), `${selector} missing in script`);
    assert.ok(styles.includes(selector), `${selector} missing in styles`);
  }
  assert.match(styles, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});

test('hero content and separate artwork are present in layer order', () => {
  const hero = html.match(/<main\b[^>]*id="home"[^>]*>([\s\S]*?)<\/main>/)?.[1];
  assert.ok(hero);
  const classes = ['hero-heading', 'chess-piece', 'hero-subtitle', 'chessboard'];
  const positions = classes.map((name) => hero.indexOf(`class="${name}"`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  for (const [className, asset] of [
    ['chess-piece', 'chess-piece.png'],
    ['chessboard', 'chessboard-trimmed.png'],
  ]) {
    const image = openingTag('img', new RegExp(`class="${className}"`));
    assert.equal(attribute(image, 'src'), `/assets/${asset}`);
    assert.equal(attribute(image, 'alt'), '');
    assert.ok(existsSync(`${root}public/assets/${asset}`));
    const data = readFileSync(new URL(`../public/assets/${asset}`, import.meta.url));
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok([4, 6].includes(data[25]) || data.includes(Buffer.from('tRNS')), `${asset} needs an alpha channel or transparency chunk`);
  }
  assert.match(html, /src="\/assets\/award\.svg"/);
  assert.match(read('public/assets/award.svg'), /<svg\b/);
});

// Model only the DOM APIs used by this module; this is not a browser test.
function createHarness() {
  const handlers = new Map();
  const makeElement = () => ({
    handlers: new Map(),
    attributes: {},
    addEventListener(type, handler) { this.handlers.set(type, handler); },
    removeEventListener(type) { this.handlers.delete(type); },
    contains(target) { return target === this || target?.parent === this; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    dispatch(type, event = {}) { this.handlers.get(type)?.(event); },
  });
  const button = makeElement();
  const menu = makeElement();
  menu.hidden = true;
  const icon = { loaded: false, classList: { toggle(name, value) { assert.equal(name, 'is-loaded'); icon.loaded = value; } } };
  const image = Object.assign(makeElement(), {
    complete: false,
    naturalWidth: 0,
    closest(selector) { assert.equal(selector, '.icon'); return icon; },
  });
  const document = {
    querySelector(selector) { assert.equal(selector, '.menu-trigger[aria-controls="site-menu"]'); return button; },
    getElementById(id) { assert.equal(id, 'site-menu'); return menu; },
    querySelectorAll(selector) {
      if (selector === '.icon img') return [image];
      if (selector === '.deco-code img, .deco-network img') return [];
      throw new Error(`Unexpected selector: ${selector}`);
    },
    addEventListener(type, handler) { handlers.set(type, handler); },
  };
  const executable = script.replace(/^import\s+['"]\.\/styles\.scss['"];?\s*/, '');
  runInNewContext(executable, { document });
  return { button, menu, handlers, image, icon };
}

test('menu toggle, inside/outside click, Escape focus and link selection', () => {
  const { button, menu, handlers } = createHarness();
  button.dispatch('click');
  assert.equal(menu.hidden, false);
  assert.equal(button.attributes['aria-expanded'], 'true');
  handlers.get('click')({ target: button });
  handlers.get('click')({ target: { parent: menu } });
  assert.equal(menu.hidden, false);
  handlers.get('keydown')({ key: 'Escape' });
  assert.equal(menu.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
  assert.equal(button.focused, true);
  button.dispatch('click');
  handlers.get('click')({ target: {} });
  assert.equal(menu.hidden, true);
  button.dispatch('click');
  menu.dispatch('click', { target: { closest: (selector) => selector === 'a' } });
  assert.equal(menu.hidden, true);
  assert.equal(button.attributes['aria-expanded'], 'false');
});

test('CDN icon fallback stays visible on error and hides on successful load', () => {
  const { image, icon } = createHarness();
  assert.equal(icon.loaded, false);
  image.complete = true;
  image.dispatch('error');
  assert.equal(icon.loaded, false);
  image.naturalWidth = 24;
  image.dispatch('load');
  assert.equal(icon.loaded, true);
});
