# Publishing this package

The identity is already filled in everywhere: the npm package is
`@ignotuss/dsh-desktop-bridge`, the repository is
`https://github.com/ignotuss/dsh-desktop-bridge`, and the LICENSE names
`ignotuss`. Nothing needs editing before you publish.

> **Check the npm scope first.** The npm account or organisation `ignotuss` has
> to be *yours on npm* — owning the GitHub handle `ignotuss` proves nothing, they
> are separate registries. Run `npm login` and then `npm whoami`; if it prints
> anything other than `ignotuss`, either register that username (or an
> organisation of that name) on npmjs.com, or publish under a scope you do own
> and update these four places: `package.json` (`name`, `repository`, `bugs`,
> `homepage`), `cordis.patch.yml` (`name`), `README.md`, `README.zh.md`.

## 1. It is already published

`@ignotuss/dsh-desktop-bridge@0.1.0` went out on 2026-10-02T02:54:12Z with shasum
`21a7e9a98276c65483800132bf2ea91b600871c1`, so everything below is the recipe for
the **next** release — read it again before bumping the version.

```bash
npm view @ignotuss/dsh-desktop-bridge versions
```

## 2. Check what would ship

```bash
npm pack --dry-run
```

Expect exactly eight entries: `package.json`, `LICENSE`, `README.md`,
`README.zh.md`, `SECURITY.md`, `cordis.patch.yml`, `src/index.js`,
`bin/bridge-client.mjs`. If anything else appears — a descriptor, an audit log, a
`.tmp` file — fix `.gitignore` and the `files` field before publishing. CI runs
this check on every push.

## 3. Run the tests

```bash
node --test
```

23 tests, none of which need DSH running. They cover routing, the auth and origin
gates, the allowlist, auditing, and the descriptor lifecycle.

## 4. Create the repository

The repository name is free as of 2026-10-02
(`https://github.com/ignotuss/dsh-desktop-bridge` answers 404). Repository names
cannot contain `@` or `/`, so the repository is plain `dsh-desktop-bridge` while
the package keeps its scope — that pairing is the normal convention.

```bash
git init -b main
git add -A
git commit -m "dsh-desktop-bridge 0.1.0"
git remote add origin https://github.com/ignotuss/dsh-desktop-bridge.git
git push -u origin main
```

## 5. Publish

```bash
npm login
npm publish --access public
```

`publishConfig.access` is already `public`, which a scoped package needs.
`.github/workflows/publish.yml` does the same on a `v*` tag using an `NPM_TOKEN`
secret, with provenance — use whichever fits your habits. It refuses to publish
when the tag and `package.json` version disagree.

> **pnpm 11 and fresh releases.** pnpm 11 enables `minimumReleaseAge` (1440
> minutes) by default, so a version published minutes ago is younger than the
> policy allows. Observed on pnpm 11.7.0: the install still succeeds — pnpm
> appends the package to `minimumReleaseAgeExclude` in the consuming profile's
> `pnpm-workspace.yaml` and prints a notice. Under
> `minimumReleaseAgeStrict: true` it fails instead, and the fix is that same
> exclusion written by hand:
>
> ```yaml
> minimumReleaseAgeExclude:
>   - '@ignotuss/dsh-desktop-bridge'
> ```

> **Registry metadata lag.** Just after a publish the tarball is already
> fetchable while the packument (`GET /@ignotuss%2Fdsh-desktop-bridge`) keeps
> answering `404` for a few minutes; during that window `dsh plugin add <name>`
> fails with `ERR_PNPM_FETCH_404` even though the bytes are live. Measured on
> this release: about six minutes, while
> `GET /@ignotuss/dsh-desktop-bridge/0.1.0` answered `200` the whole time. Retry
> rather than re-publishing.

## 6. Verify the install path a reader will take

On a machine that is **not** the one you develop on:

```bash
dsh plugin --profile web add @ignotuss/dsh-desktop-bridge
```

Then confirm the plugin is listed and enabled under Settings → Plugins, and that
`<DSH_HOME>/desktop-bridge.json` appears with a port and a token. In the desktop
app the same add runs through Plugins → Add plugin, because the CLI refuses the
`desktop` profile by design.

Finally, check the by-chat route the README promises: in a session using the
`cordis` agent preset, ask the agent to install the plugin and confirm it can.
On the `standard` and `ptc` presets it cannot — those switch the plugin-manager
tool off.

## 7. Tag it

```bash
git tag v0.1.0
git push --tags
```

Keep `CHANGELOG.md` current; the publish workflow does not read it, but readers
do.
