# s-s01s-proof

- **role**: Model
- **state**: blocked
- **issue**: #11
- **task**: proof.json + 7 all-spot replays generated on model/proof-json (stacked on #39)
- **next**: rebuild replays when #39 merges with arrival fix, then mark PR ready
- **needs**: #39 merged + arrival_window p0-anchor fix (alfredo-model, see #39 comment)
- **notes**: (a) one target full set 6x7 = 184 s wall (all 10 cores, LightGBM default threads; ~216% CPU, data-bound); 3 targets in parallel at 3 threads each = 2-3.3 min. (b) LOFO: 16 models (e2007/e2012/e2014/e2021 x 4 targets; test-period events reuse the time-split models, identical result) est. 15-25 min at 4 procs x 2 threads, full SPEC 7.3 params, no round cap. (c) os.cpu_count()=10
- **branch**: model/proof-json
- **head**: a7dd9ce Generate proof.json and leave-one-flood-out replays for all fo
- **unpushed**: 0
- **dirty**: 0
- **updated**: 2026-10-24T17:18:04Z
