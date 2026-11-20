<p align="center">
  <img src="logo.png" alt="ScummBench cursor detective reviewing an evaluation clipboard" width="256" />
  <br />
  <!-- repo-tagline:start -->
  <strong>🧭 Evaluate agents through adventure games 🕹️</strong>
  <!-- repo-tagline:end -->
</p>

# ScummBench

ScummBench evaluates agents on adventure-game tasks using ScummWEB's engine
telemetry. Its first development task grades whether the agent reaches the
opening hotel's laundry room in *Flight of the Amazon Queen*.

**Development status.** Results are provisional. The runner does not enforce
isolation against a hostile agent, and local runs are ineligible for official
scores. See [registered results](BENCHMARKS.md).

## Try it

With Node.js 22+, Python 3.11+, and uv installed, run from the checkout:

```sh
uv tool install --editable . --exclude-newer "7 days"
scummbench tasks
```

This prints the available tasks without starting a game. Follow the
[first-run guide](docs/first-run.md) to configure a ScummWEB backend and verify
an offline observer run. See the [agent protocol](docs/agent-protocol.md)
to connect your own agent and [evaluation](docs/evaluation.md) for grading.

Game assets are supplied separately under their own terms. Code distribution
licensing has not been selected.
