# Browser pipeline measurements

Run from the repository root with Docker and at least four available CPUs:

```sh
docker build -f scripts/bench/pipeline/Dockerfile -t wdio-video-pipeline:local .
corepack npm run bench:pipeline -- --baseline 0b61d4f8a79be92dd4ffce315d4d2cc9e0a8a798
```

`--image` selects an existing image. The runner resolves its immutable image ID
once, snapshots both product revisions and the test harness, and uses that same
image and dependency tree for every measurement. The baseline is exported with
`git archive`; it does not need a separate checkout or installed dependencies.
`--output` selects a new output directory; existing snapshots are never reused.
Output and resume directories must be inside `tests/results/pipeline`; anything
else, including a link that leads out of it, is rejected before a run starts.
The default is a new timestamped directory there.
`--smoke` runs one pair at 2 CPUs / 2 workers without a soak and explicitly marks
its output as **not qualification**.

This is a local developer tool. Use trusted Git, tar and Docker executables on
your PATH, a trusted image and source revision, and keep `tests/results`
writable only by the test user. Resume only your own trusted saved runs. The
disposable measurement container runs as root to retain the pinned benchmark
environment and output permissions. It has no privileged mode or Docker socket;
source mounts are read-only and the selected results directory is the only
writable host mount.
Do not use this harness to execute untrusted images, source or saved metadata.

After an interrupted full run, use `--resume <output-directory>`. Resume verifies
the saved image, Docker environment, candidate source and harness hashes. Complete
pairs and all failed observations are retained; a partially completed healthy
pair runs again as a group. Earlier JSON and per-run artifacts remain intact,
and resumed runs receive distinct names. A failed observation cannot be retried
into a pass by this command. Changed product code requires a fresh output directory.

The matrix covers 2 CPUs / 2 workers, 4 CPUs / 4 workers, and an oversubscribed
2 CPUs / 4 workers. Each shape runs retained (`all`) and discarded (`failures`,
with passing tests) recordings. Four spec files each exercise a static page and
continuous animation at 1920 × 1080 using the default profile and capture quality.
Each test holds its page for two seconds. These dwells are the recording workload;
element assertions perform synchronization. The separate five-minute animated
soak uses one worker on two CPUs. It is not folded into suite-time comparisons.

Each of five pairs runs recording disabled, baseline, and candidate sequentially.
Alternate pairs reverse the order. Run on an otherwise idle host, and compare
within the same invocation rather than between unrelated CI machines. CPU quota
is applied to the whole browser/worker/encoder container, with a 7 GiB memory
limit. Each container is removed after it exits or reaches its outer deadline,
including browser and encoder descendants.

## Evidence and interpretation

The workflow `Recording Pipeline Performance` uploads the complete result
directory, including synthetic-fixture recordings. No external site is loaded.
The installed consumer matrix uploads only JSON and logs; product recordings
remain excluded from the general browser diagnostics workflow.

- `environment.json`: source and harness hashes, Git baseline/current HEAD,
  host CPU availability, Docker version and immutable image ID. Each run adds
  actual dependency-lock hash, runtime/peer/browser/FFmpeg versions, CPU quota,
  memory limit, CPU model and kernel. Dirty candidate source is identified by
  its content hash, not attributed to the unchanged HEAD.
- `results.json` and each `result.json`: elapsed suite time from WDIO process
  launch through exit, worker telemetry, artifact sizes, decoded frame count,
  duration/dimensions and fixture pixel evidence. Media validation happens after
  the measured interval. Invalid tests, missing workers, incomplete/discarded
  captures in retained mode, decode failures and missing fixture colors invalidate
  the measurement; they cannot make a faster run pass.
- `worker-*.json`: RSS and V8 heap every 200 ms plus startup/stop samples, event-loop
  mean/p95/max, test counts and all raw samples. Startup and stop times cover the
  public service hooks, including first-frame readiness and artifact finalization.
  Peak worker memory is the largest observed individual worker RSS; browser and
  encoder memory are not mislabeled as worker memory. Sampling can miss short peaks.
- `comparison.json`: median **paired ratios**, recording overhead relative to the
  disabled run, every pair, and whether the run `passed`. A median suite regression
  above 10%, or peak worker RSS regression above 15%, seen in a majority of pairs
  returns an `investigate` status. Each workload's status names whose measurement
  failed:
  - `candidate-invalid`: fails the run, whatever the baseline did.
  - `incomplete`: a missing run or an invalid recording-disabled run. It also fails.
  - `baseline-invalid`: the baseline could not record that workload validly. For
    example, `1.0.0-rc.5` reports its oversubscribed retained recordings as
    incomplete. The workload has no ratios, and it does not fail a run whose
    candidate observations are all valid.
  - `pass`.

  The run exits nonzero unless every workload is `pass` or `baseline-invalid` and
  the soak is valid. These are investigation gates, never reasons to weaken the
  media assertions or change codec quality.
- `soak.json`: successive minute medians after the first minute of warm-up. Growth
  above 2% in every window and above 15% overall requires investigation. Raw RSS
  and heap samples remain available for examining collection cycles or smaller
  trends; a flat five-minute run is not proof against every possible leak.

The short mixed suite is deliberately repeatable and bounded. It complements
the existing real-media timeline, sustained-animation, crop/scale/window-change,
shutdown, and process-liveness tests; it does not replace release validation or
represent arbitrary consumer test suites. Record substantive environment noise
and rerun the full pairs if it affects interpretation.
