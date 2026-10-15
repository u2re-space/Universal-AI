import { reindentSource } from './reindent.mjs';

const src = `function jsImportSpecs(text) {
  const patterns = [
    /\\bfrom\\s+(['"])(\\.[^'"]*)\\1/g,
    /\\bimport\\s+(['"])(\\.[^'"]*)\\1/g,
    /\\brequire\\(\\s*(['"])(\\.[^'"]*)\\1\\s*\\)/g,
  ];
  return patterns;
}
`;
console.log(reindentSource(src));
console.log('---CHARS---');
const line = String.raw`    /\bfrom\s+(['"])(\.[^'"]*)\1/g,`;
console.log(line);
