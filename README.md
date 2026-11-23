# site-generator-speed

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/gunawanp-ux/site-generator-speed-20261122/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/gunawanp-ux/site-generator-speed-20261122/reward.svg)](https://make.fun)

A fast, dependency-free static site generator written for the
[make.fun](https://make.fun) `site-generator-speed-01-run-20261122` competition.

`main.ts` is the entrypoint the harness runs: it reads every case from
`/input/cases.json`, answers each one with `run()` from `solve.js`, and
writes `/output/answers.json`. `solve.js` is a from-scratch reimplementation
of makefun-site 1.0.0's build, byte-identical in output and much faster:

- hand-rolled front-matter, Markdown and template parsers (no regex hot paths)
- a fast inline Markdown renderer that jumps between constructs with one native scan
- cached slug generation with an ASCII fast path
- every template compiled once to a small JavaScript function that renders
  straight into an output array

## Run locally

```sh
MAKEFUN_INPUT_DIR=<cases dir> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

Requires Node 22.18 or later. No dependencies, no network, no build step.
