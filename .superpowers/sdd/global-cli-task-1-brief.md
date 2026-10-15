### Task 1: Package name

**Files:**
- Modify: `package.json` (`name`)
- Test: `test/cli.test.js` (append)

**Interfaces:**
- Consumes: nothing
- Produces: `package.json` `name` equal to `universal-ai` and `bin.ai` equal to `./bin/ai.js`. `ai --version` then prints `universal-ai 1.0.0` because `src/cli.js` prints `pkg.name` and `pkg.version`.

- [ ] **Step 1: Write the failing test**

Append this test to `test/cli.test.js`:

```javascript
test('package manifest name is universal-ai', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'universal-ai');
  assert.equal(pkg.bin.ai, './bin/ai.js');
});
```

`readFile` and `assert` are already imported in that file.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test --test-timeout=60000 --test-name-pattern "package manifest name is universal-ai" test/cli.test.js
```

Expected: FAIL. The assertion reports `'ai-agent-cli' !== 'universal-ai'`.

- [ ] **Step 3: Change the package name**

In `package.json`, replace `"name": "ai-agent-cli"` with `"name": "universal-ai"`. Leave `bin`, `files`, `engines`, and `version` as they are.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
node --test --test-timeout=60000 --test-name-pattern "package manifest name is universal-ai" test/cli.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json test/cli.test.js
git commit -m "$(cat <<'EOF'
feat: name the package universal-ai

EOF
)"
```

---

